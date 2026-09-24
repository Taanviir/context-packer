/**
 * Rewrites each test commit subject into the request a developer would type, without naming the files or
 * identifiers the change touches, so the answer can't leak. Uses Claude Code headless (`claude -p`) with the
 * caller's own login. Results go to bench/tasks/realistic.json and are resumable.
 *
 *   pnpm tsx bench/realistic.ts [repo...]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tokens } from "../src/bm25.js";
import { git } from "./git.js";
import type { Task } from "./mine.js";
import { REPOS, repoDir, TASKS } from "./repos.js";

export interface Rewrite {
  request: string;
  /** Why the rewrite was rejected, when it was; the benchmark then falls back to the commit subject. */
  rejected?: string;
}

const OUT = path.join(TASKS, "realistic.json");
const MAX_DIFF = 6_000;

function prompt(t: Task, diff: string, feedback?: string): string {
  return [
    "You are helping build a benchmark for code search. Below is a real commit: its message and its diff.",
    "Write the request a developer would type to a coding assistant BEFORE this change existed, asking for it.",
    "Rules:",
    "- One to three sentences, plain language, describing the problem or the behaviour wanted.",
    "- Do not mention any file name, directory or path.",
    "- Do not mention function, class, method, variable or type names that appear only in the diff. Names a user of the project would know (public API, CLI flags, config keys already in the message) are fine.",
    "- Do not describe the implementation; describe what should happen.",
    feedback ? `- Your previous attempt was rejected: ${feedback}` : "",
    "Reply with the request only, no quotes or preamble.",
    "",
    `Commit message: ${t.task}`,
    "",
    "Diff:",
    diff,
  ].filter(Boolean).join("\n");
}

/** Identifiers the diff introduces or removes that the commit message doesn't already use. */
function diffIdentifiers(diff: string, message: string): Set<string> {
  const known = new Set(tokens(message));
  const ids = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!/^[+-][^+-]/.test(line)) continue;
    for (const m of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{5,}\b/g)) {
      const id = m[0];
      if (/[a-z][A-Z]|_/.test(id) && !tokens(id).every((w) => known.has(w))) ids.add(id);
    }
  }
  return ids;
}

export function leak(request: string, t: Task, ids: Set<string>): string | null {
  const lower = request.toLowerCase();
  for (const g of t.gold) {
    const base = path.basename(g).toLowerCase();
    if (lower.includes(base)) return `it names the file ${base}`;
    if (lower.includes(path.dirname(g).toLowerCase() + "/")) return `it names the directory ${path.dirname(g)}`;
  }
  for (const id of ids) if (request.includes(id)) return `it names ${id}, which appears only in the diff`;
  return null;
}

function ask(text: string): string {
  return execFileSync("claude", ["-p", "--model", "sonnet", "--no-session-persistence", "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Agent"],
  { input: text, encoding: "utf8", timeout: 180_000, cwd: path.join(import.meta.dirname, ".cache") }).trim();
}

async function main() {
  const only = process.argv.slice(2);
  const done: Record<string, Rewrite> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  for (const repo of REPOS.filter((r) => !only.length || only.includes(r.name))) {
    const tasks: Task[] = JSON.parse(readFileSync(path.join(TASKS, `${repo.name}.json`), "utf8")).test;
    for (const t of tasks) {
      if (done[t.id]) continue;
      const diff = git(repoDir(repo.name), ["show", "--format=", "--unified=2", t.commit, "--", ...t.gold]).slice(0, MAX_DIFF);
      const ids = diffIdentifiers(diff, t.task);
      let request = ask(prompt(t, diff));
      let problem = leak(request, t, ids);
      if (problem) {
        request = ask(prompt(t, diff, problem));
        problem = leak(request, t, ids);
      }
      done[t.id] = problem ? { request, rejected: problem } : { request };
      writeFileSync(OUT, JSON.stringify(done, null, 1) + "\n");
      console.log(`${t.id}${problem ? " REJECTED " + problem : ""}\n  ${t.task}\n  -> ${request}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
