/**
 * Does handing Claude Code the ranked files make it work faster? Each task runs headless in a clean worktree at
 * the commit before the change, under three arms: no hook, the hook with Jev's file list, and the hook with the
 * file list plus the most relevant lines. Uses the caller's own Claude Code login; stops cleanly on a usage limit
 * and skips runs that already have results.
 *
 *   pnpm tsx bench/agent.ts [--tasks 10] [--model opus] [--arms none,files,code]
 *   pnpm tsx bench/agent.ts --report      # per-arm averages over tasks every arm finished
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { Task } from "./mine.js";
import type { Rewrite } from "./realistic.js";
import { CACHE, repoDir, RESULTS, TASKS } from "./repos.js";

export const ARMS = ["none", "files", "code"] as const;
export type Arm = (typeof ARMS)[number];
const AGENT_REPOS = ["hono", "rich", "gin", "prometheus"];
const OUT = path.join(RESULTS, "agent");
/** Full session transcripts stay local: they contain the repositories' source. */
const TRANSCRIPTS = path.join(CACHE, "agent-transcripts");
const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");
const RUN_TIMEOUT_MS = 20 * 60_000;

/** Read-only shell commands are allowed so the agent can explore the way it normally would. */
const ALLOWED = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep",
  ...["git log", "git show", "git grep", "ls", "find", "grep", "rg", "cat", "head", "tail", "wc", "sed -n"].map((c) => `Bash(${c}:*)`)];

export interface AgentRun {
  id: string;
  repo: string;
  arm: Arm;
  model: string;
  request: string;
  gold: string[];
  /** Files the hook put in front of the agent, in order. */
  handed: string[];
  /** Whether the hook's context actually appears in the session, not just whether it would have been sent. */
  hookSeen: boolean;
  edited: string[];
  /** Share of the commit's files the agent edited. */
  goldEdited: number;
  extraEdits: number;
  turns: number;
  tools: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  ms: number;
  isError: boolean;
  error?: string;
}

function tasksFor(limit: number): Array<Task & { request: string }> {
  const rewrites: Record<string, Rewrite> = JSON.parse(readFileSync(path.join(TASKS, "realistic.json"), "utf8"));
  const perRepo = AGENT_REPOS.map((r) => (JSON.parse(readFileSync(path.join(TASKS, `${r}.json`), "utf8")).test as Task[])
    .filter((t) => rewrites[t.id] && !rewrites[t.id]!.rejected)
    .map((t) => ({ ...t, request: rewrites[t.id]!.request })));
  // Round-robin across repositories so a small pilot still covers all four.
  const out: Array<Task & { request: string }> = [];
  for (let i = 0; out.length < limit && perRepo.some((list) => i < list.length); i++) {
    for (const list of perRepo) if (i < list.length && out.length < limit) out.push(list[i]!);
  }
  return out;
}

function hookSettings(arm: Arm): string | null {
  if (arm === "none") return null;
  const env = `CONTEXT_PACKER_HOOK_PROVIDER=jev CONTEXT_PACKER_HOOK_LIMIT=8 CONTEXT_PACKER_HOOK_CODE=${arm === "code" ? 3 : 0}`;
  return JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", timeout: 60, command: `${env} node ${CLI} hook` }] }] } });
}

const prompt = (t: { request: string }) =>
  `${t.request}\n\nMake this change in the code. Don't run the test suite, install packages or commit.`;

/** What the hook would hand over for this prompt, computed the same way the hook computes it. */
function handed(arm: Arm, cwd: string, text: string): string[] {
  if (arm === "none") return [];
  const env = { ...process.env, CONTEXT_PACKER_HOOK_PROVIDER: "jev", CONTEXT_PACKER_HOOK_LIMIT: "8", CONTEXT_PACKER_HOOK_CODE: arm === "code" ? "3" : "0" };
  const out = execFileSync("node", [CLI, "hook"], { input: JSON.stringify({ prompt: text, cwd }), env, encoding: "utf8" });
  if (!out.trim()) return [];
  const context: string = JSON.parse(out).hookSpecificOutput.additionalContext;
  return [...context.matchAll(/^[0-9.]+ {3}(\S+)/gm)].map((m) => m[1]!);
}

function runClaude(cwd: string, text: string, model: string, settings: string | null): Promise<{ events: any[]; ms: number; killed: boolean }> {
  const args = ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--permission-mode", "acceptEdits", "--allowedTools", ...ALLOWED, "--disallowedTools", "WebFetch", "WebSearch", "Agent", "Task"];
  if (settings) args.push("--settings", settings);
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let killed = false;
    const events: any[] = [];
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) try { events.push(JSON.parse(line)); } catch {}
      }
    });
    child.stdin.end(text);
    child.on("close", () => { clearTimeout(timer); resolve({ events, ms: Math.round(performance.now() - started), killed }); });
  });
}

function editedFiles(cwd: string): string[] {
  const changed = execFileSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8" }).split("\n");
  const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }).split("\n");
  return [...new Set([...changed, ...added].filter(Boolean))].sort();
}

function summarize(t: Task & { request: string }, arm: Arm, model: string, handedFiles: string[], cwd: string, run: { events: any[]; ms: number; killed: boolean }): AgentRun {
  const result = [...run.events].reverse().find((e) => e.type === "result") ?? {};
  const tools: Record<string, number> = {};
  for (const e of run.events) {
    if (e.type !== "assistant") continue;
    for (const block of e.message?.content ?? []) if (block.type === "tool_use") tools[block.name] = (tools[block.name] ?? 0) + 1;
  }
  const edited = editedFiles(cwd);
  const gold = new Set(t.gold);
  const usage = result.usage ?? {};
  return {
    id: t.id, repo: t.repo, arm, model, request: t.request, gold: t.gold, handed: handedFiles,
    hookSeen: run.events.some((e) => e.type === "system" && String(e.content ?? "").includes("Context Packer ranked the project")),
    edited,
    goldEdited: t.gold.filter((g) => edited.includes(g)).length / t.gold.length,
    extraEdits: edited.filter((e) => !gold.has(e)).length,
    turns: result.num_turns ?? 0,
    tools,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    ms: result.duration_ms ?? run.ms,
    isError: run.killed || !!result.is_error || result.subtype !== "success",
    ...(run.killed ? { error: "timed out" } : result.is_error || result.subtype !== "success" ? { error: String(result.result ?? result.subtype ?? "no result") } : {}),
  };
}

/** Averages per arm and how many tasks each hook arm beat "none" on, over tasks that every arm finished. */
function report() {
  const runs: AgentRun[] = readdirSync(OUT).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(OUT, f), "utf8")));
  const byTask = new Map<string, Partial<Record<Arm, AgentRun>>>();
  for (const r of runs) byTask.set(r.id, { ...byTask.get(r.id), [r.arm]: r });
  const tasks = [...byTask.values()].filter((t) => ARMS.every((a) => t[a] && !t[a]!.isError)) as Array<Record<Arm, AgentRun>>;
  const searches = (r: AgentRun) => (r.tools.Grep ?? 0) + (r.tools.Glob ?? 0) + (r.tools.Bash ?? 0);
  const metrics: Array<[string, (r: AgentRun) => number, "lower" | "higher"]> = [
    ["turns", (r) => r.turns, "lower"], ["searches", searches, "lower"], ["reads", (r) => r.tools.Read ?? 0, "lower"],
    ["needed files edited", (r) => r.goldEdited, "higher"], ["cost $", (r) => r.costUsd, "lower"], ["time s", (r) => r.ms / 1000, "lower"],
  ];
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const summary = {
    tasks: tasks.length,
    metrics: Object.fromEntries(metrics.map(([name, f, better]) => [name, Object.fromEntries(ARMS.map((arm) => {
      const d = tasks.map((t) => f(t[arm]) - f(t.none));
      return [arm, { mean: mean(tasks.map((t) => f(t[arm]))), better: d.filter((x) => (better === "lower" ? x < 0 : x > 0)).length, worse: d.filter((x) => (better === "lower" ? x > 0 : x < 0)).length }];
    }))])),
  };
  writeFileSync(path.join(RESULTS, "agent-summary.json"), JSON.stringify(summary, null, 1) + "\n");
  console.log(`${tasks.length} tasks with all arms`);
  for (const [name, arms] of Object.entries(summary.metrics)) {
    console.log(`${name.padEnd(20)} ${ARMS.map((a) => `${a} ${arms[a]!.mean.toFixed(2)}${a === "none" ? "" : ` (better on ${arms[a]!.better}, worse on ${arms[a]!.worse})`}`).join("   ")}`);
  }
}

const LIMIT_HIT = /usage limit|rate limit|limit reached|quota|try again later|overloaded/i;

async function main() {
  const { values } = parseArgs({ options: { tasks: { type: "string" }, model: { type: "string" }, arms: { type: "string" }, report: { type: "boolean" } } });
  if (values.report) return report();
  const model = values.model ?? "opus";
  const arms = (values.arms?.split(",") ?? [...ARMS]) as Arm[];
  const tasks = tasksFor(Number(values.tasks ?? 10));
  mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const t of tasks) {
    // Rotate the arm order per task so any drift over a long batch is spread across arms.
    const order = arms.map((_, i) => arms[(i + n) % arms.length]!);
    n++;
    for (const arm of order) {
      const file = path.join(OUT, `${t.id}.${arm}.json`);
      if (existsSync(file)) continue;
      const wt = path.join(CACHE, "worktrees", `${t.id}-${arm}`);
      rmSync(wt, { recursive: true, force: true });
      execFileSync("git", ["-C", repoDir(t.repo), "worktree", "prune"]);
      execFileSync("git", ["-C", repoDir(t.repo), "worktree", "add", "--detach", "--force", wt, t.parent], { stdio: "ignore" });
      try {
        const text = prompt(t);
        const handedFiles = handed(arm, wt, text);
        const run = await runClaude(wt, text, model, hookSettings(arm));
        const result = summarize(t, arm, model, handedFiles, wt, run);
        mkdirSync(TRANSCRIPTS, { recursive: true });
        writeFileSync(path.join(TRANSCRIPTS, `${t.id}.${arm}.jsonl`), run.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
        if (result.isError && LIMIT_HIT.test(result.error ?? "")) {
          console.log(`Stopping: ${result.error}. Completed runs are kept; re-run to resume.`);
          return;
        }
        writeFileSync(file, JSON.stringify(result, null, 1) + "\n");
        console.log(`${t.id} ${arm.padEnd(5)} turns=${result.turns} reads=${result.tools.Read ?? 0} searches=${(result.tools.Grep ?? 0) + (result.tools.Glob ?? 0) + (result.tools.Bash ?? 0)} gold=${result.goldEdited.toFixed(2)} $${result.costUsd.toFixed(2)} ${(result.ms / 1000).toFixed(0)}s${result.error ? " ERROR " + result.error.slice(0, 80) : ""}`);
      } finally {
        execFileSync("git", ["-C", repoDir(t.repo), "worktree", "remove", "--force", wt], { stdio: "ignore" });
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
