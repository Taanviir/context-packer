/**
 * Aggregates bench/results into summary.json: mean recall per repo, split and variant, and paired
 * bootstrap intervals for the differences that matter.
 *
 *   npx tsx bench/report.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPOS, RESULTS } from "./repos.js";
import { KS, type TaskResult } from "./run.js";

const VARIANTS = ["keywords", "jev", "jev-lang", "laya"] as const;
const COMPARISONS = [["jev", "keywords"], ["jev-lang", "jev"], ["laya", "keywords"]] as const;
const SPLITS = ["dev", "test"] as const;

function load(repo: string, split: string, variant: string): TaskResult[] | null {
  const file = path.join(RESULTS, `${repo}.${split}.${variant}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).results : null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Deterministic xorshift, so the published intervals can be reproduced exactly. */
function rng(seed: number) {
  let x = seed;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

function bootstrap(diffs: number[], rounds = 10_000): [number, number] {
  const next = rng(20260923);
  const means = Array.from({ length: rounds }, () => mean(diffs.map(() => diffs[Math.floor(next() * diffs.length)]!))).sort((a, b) => a - b);
  return [means[Math.floor(rounds * 0.025)]!, means[Math.floor(rounds * 0.975)]!];
}

function summarize(results: TaskResult[]) {
  return {
    tasks: results.length,
    candidates: Math.round(mean(results.map((r) => r.candidates))),
    recall: Object.fromEntries(KS.map((k) => [k, mean(results.map((r) => r.recall[k]!))])),
    ms: Math.round(mean(results.map((r) => r.ms))),
    costUsd: mean(results.map((r) => r.costUsd)),
    inputTokens: Math.round(mean(results.map((r) => r.inputTokens))),
    failedBatches: results.reduce((s, r) => s + r.failedBatches, 0),
  };
}

function compare(a: TaskResult[], b: TaskResult[]) {
  const byId = new Map(b.map((r) => [r.id, r]));
  const pairs = a.filter((r) => byId.has(r.id));
  return Object.fromEntries(KS.map((k) => {
    const diffs = pairs.map((r) => r.recall[k]! - byId.get(r.id)!.recall[k]!);
    const [lo, hi] = bootstrap(diffs);
    return [k, { diff: mean(diffs), lo, hi, tasks: pairs.length }];
  }));
}

const repos: Record<string, unknown> = {};
const pooled: Record<string, Record<string, TaskResult[]>> = {};
for (const repo of REPOS) {
  const perSplit: Record<string, unknown> = {};
  for (const split of SPLITS) {
    const variants: Record<string, unknown> = {};
    const loaded: Record<string, TaskResult[]> = {};
    for (const v of VARIANTS) {
      const r = load(repo.name, split, v);
      if (!r) continue;
      loaded[v] = r;
      variants[v] = summarize(r);
      ((pooled[split] ??= {})[v] ??= []).push(...r);
    }
    const comparisons = Object.fromEntries(COMPARISONS.filter(([a, b]) => loaded[a] && loaded[b]).map(([a, b]) => [`${a} vs ${b}`, compare(loaded[a]!, loaded[b]!)]));
    perSplit[split] = { variants, comparisons };
  }
  repos[repo.name] = { url: repo.url, language: repo.language, head: repo.head, jev: repo.jev, ...perSplit };
}

// Comparisons pair tasks by id, so each one only covers repos where both variants ran. The pooled keyword
// summary is restricted to the Jev repos for the same reason.
const jevRepos = new Set(REPOS.filter((r) => r.jev).map((r) => r.name));
const pooledSummary = Object.fromEntries(SPLITS.map((split) => {
  const sets = pooled[split] ?? {};
  const shown: Record<string, TaskResult[]> = { ...sets, keywords: (sets.keywords ?? []).filter((r) => jevRepos.has(r.id.split("-")[0]!)) };
  return [split, {
    variants: Object.fromEntries(Object.entries(shown).filter(([v]) => v !== "laya").map(([v, r]) => [v, summarize(r)])),
    comparisons: Object.fromEntries(COMPARISONS.filter(([a, b]) => sets[a] && sets[b]).map(([a, b]) => [`${a} vs ${b}`, compare(sets[a]!, sets[b]!)])),
  }];
}));

const summary = { generated: new Date().toISOString().slice(0, 10), repos, pooled: pooledSummary };
writeFileSync(path.join(RESULTS, "summary.json"), JSON.stringify(summary, null, 1) + "\n");

const pct = (x: number) => x.toFixed(3);
for (const split of SPLITS) {
  console.log(`\n${split}`);
  for (const repo of REPOS) {
    const s = (repos[repo.name] as any)[split];
    const cells = VARIANTS.map((v) => (s.variants[v] ? `${v} ${pct(s.variants[v].recall[10])}` : "")).filter(Boolean);
    console.log(`  ${repo.name.padEnd(11)} R@10  ${cells.join("  ")}`);
  }
  for (const [name, c] of Object.entries((pooledSummary as any)[split].comparisons)) {
    const r = (c as any)[10];
    console.log(`  pooled ${name}: R@10 ${r.diff >= 0 ? "+" : ""}${pct(r.diff)} [${pct(r.lo)}, ${pct(r.hi)}] n=${r.tasks}`);
  }
}
