/**
 * Runs one ranking variant over one split of the frozen tasks and writes per-task results.
 *
 *   pnpm tsx bench/run.ts <variant> <dev|test> [repo...]
 *
 * Jev responses are cached on disk by request body, so re-runs and variants that send identical
 * requests are free. BENCH_TOKEN_CAP (default 60M, about $2.50) stops the run before it bills more.
 * BENCH_IDS=a,b re-runs only those tasks and merges them into the existing results file.
 * Split "real" is the test split with each commit subject replaced by its realistic rewrite (bench/realistic.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SourceFile } from "../src/files.js";
import { JEV_INPUT_PRICE, JevClient, JevScorer } from "../src/jev.js";
import { DEFAULT_PACK_CONFIG, pack, type PackResult } from "../src/packer.js";
import { ContextPacker, type Provider } from "../src/service.js";
import { sketch as langSketch } from "./lang-sketch.js";
import { snapshot } from "./git.js";
import type { Task } from "./mine.js";
import { CACHE, REPOS, repoDir, RESULTS, TASKS } from "./repos.js";

/** Shipped providers run through ContextPacker, exactly as the CLI does; `jev-lang` swaps in the experimental sketcher. */
const VARIANTS: Record<string, { provider: Provider; paid: boolean }> = {
  keywords: { provider: "keywords", paid: false },
  jev: { provider: "jev", paid: true },
  "jev-lang": { provider: "jev", paid: true },
  laya: { provider: "laya", paid: false },
};

export const KS = [5, 10, 20] as const;

export interface TaskResult {
  id: string;
  task: string;
  gold: string[];
  candidates: number;
  ranked: string[];
  recall: Record<string, number>;
  ms: number;
  calls: number;
  failedBatches: number;
  inputTokens: number;
  costUsd: number;
}

const OUT = process.env.BENCH_RESULTS || RESULTS;
const LEDGER = path.join(CACHE, "jev-ledger.json");
const CAP = Number(process.env.BENCH_TOKEN_CAP || 60_000_000);

function billed(): number {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")).inputTokens : 0;
}

/** fetch with a disk cache in front, counting only tokens that were actually billed. */
function cachingFetch(): typeof fetch {
  const dir = path.join(CACHE, "jev-responses");
  mkdirSync(dir, { recursive: true });
  return (async (url: string | URL, init?: RequestInit) => {
    const body = String(init?.body);
    const file = path.join(dir, createHash("sha256").update(String(url)).update(body).digest("hex") + ".json");
    if (existsSync(file)) return new Response(readFileSync(file, "utf8"), { status: 200 });
    const local = new URL(String(url)).hostname === "127.0.0.1";
    if (!local && billed() >= CAP) throw new Error(`BENCH_TOKEN_CAP reached (${billed()} tokens billed)`);
    const response = await fetch(url, init);
    const text = await response.text();
    if (response.status === 200) {
      writeFileSync(file, text);
      const tokens = JSON.parse(text)?.usage?.input_tokens ?? 0;
      if (!local) writeFileSync(LEDGER, JSON.stringify({ inputTokens: billed() + tokens }));
    }
    return new Response(text, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

export function recallAt(ranked: string[], gold: string[], k: number): number {
  const top = new Set(ranked.slice(0, k));
  return gold.filter((g) => top.has(g)).length / gold.length;
}

async function runTask(t: Task, variant: string): Promise<TaskResult> {
  const files: SourceFile[] = await snapshot(repoDir(t.repo), t.parent);
  const started = performance.now();
  let result: PackResult;
  let calls: number;
  let inputTokens: number;
  if (variant === "jev-lang") {
    const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY!, fetch: cachingFetch() });
    const docs = files.map((f) => ({ ...f, sketch: langSketch(f.path, f.text) }));
    result = await pack(t.task, docs, new JevScorer(client), { ...DEFAULT_PACK_CONFIG, keep: 20 });
    calls = client.calls.length;
    inputTokens = client.inputTokens;
  } else {
    const report = await new ContextPacker(process.env, cachingFetch()).rank({ task: t.task, provider: VARIANTS[variant]!.provider, limit: 20 }, files);
    result = report.result;
    calls = report.calls;
    inputTokens = report.inputTokens;
  }
  const ranked = result.files.map((f) => f.path);
  return {
    id: t.id,
    task: t.task,
    gold: t.gold,
    candidates: files.length,
    ranked,
    recall: Object.fromEntries(KS.map((k) => [k, recallAt(ranked, t.gold, k)])),
    ms: Math.round(performance.now() - started),
    calls,
    failedBatches: result.failedBatches,
    inputTokens,
    costUsd: variant.startsWith("jev") ? inputTokens * JEV_INPUT_PRICE / 1_000_000 : 0,
  };
}

async function main() {
  const [variant, split, ...only] = process.argv.slice(2);
  if (!variant || !VARIANTS[variant] || (split !== "dev" && split !== "test" && split !== "real")) {
    throw new Error(`usage: run.ts <${Object.keys(VARIANTS).join("|")}> <dev|test|real> [repo...]`);
  }
  const rewrites: Record<string, { request: string; rejected?: string }> =
    split === "real" ? JSON.parse(readFileSync(path.join(TASKS, "realistic.json"), "utf8")) : {};
  const { paid } = VARIANTS[variant]!;
  const repos = REPOS.filter((r) => (only.length ? only.includes(r.name) : !paid || r.jev));
  mkdirSync(OUT, { recursive: true });
  for (const repo of repos) {
    const ids = process.env.BENCH_IDS?.split(",");
    const listed: Task[] = JSON.parse(readFileSync(path.join(TASKS, `${repo.name}.json`), "utf8"))[split === "real" ? "test" : split];
    // A rejected or missing rewrite drops the task from the realistic split rather than falling back silently.
    const all = split === "real"
      ? listed.filter((t) => rewrites[t.id] && !rewrites[t.id]!.rejected).map((t) => ({ ...t, task: rewrites[t.id]!.request }))
      : listed;
    const tasks = ids ? all.filter((t) => ids.includes(t.id)) : all;
    const file = path.join(OUT, `${repo.name}.${split}.${variant}.json`);
    if (tasks.length === 0) continue;
    if (paid && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required for Jev variants");
    const results: TaskResult[] = [];
    for (const t of tasks) {
      const r = await runTask(t, variant);
      results.push(r);
      process.stderr.write(`${repo.name} ${r.id} R@10=${r.recall[10]!.toFixed(2)} ${r.ms}ms $${r.costUsd.toFixed(4)} billed=${billed()}\n`);
    }
    if (ids) {
      const byId = new Map(results.map((r) => [r.id, r]));
      const previous: TaskResult[] = JSON.parse(readFileSync(file, "utf8")).results;
      results.splice(0, results.length, ...previous.map((r) => byId.get(r.id) ?? r));
    }
    writeFileSync(file, JSON.stringify({ repo: repo.name, split, variant, results }, null, 1) + "\n");
    const mean = (k: number) => results.reduce((s, r) => s + r.recall[k]!, 0) / results.length;
    console.log(`${repo.name} ${split} ${variant}: R@5 ${mean(5).toFixed(3)} R@10 ${mean(10).toFixed(3)} R@20 ${mean(20).toFixed(3)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
