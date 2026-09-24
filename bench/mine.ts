/**
 * Turns commit history into frozen tasks: the commit subject is the task, and the source files the
 * commit modified are the answer. Files are later read as they were at the parent commit, so the
 * answer can't leak into the candidates.
 *
 *   npx tsx bench/mine.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSourcePath, MAX_BYTES } from "../src/files.js";
import { isTest } from "../src/packer.js";
import { git } from "./git.js";
import { REPOS, repoDir, TASKS } from "./repos.js";

export interface Task {
  id: string;
  repo: string;
  commit: string;
  parent: string;
  task: string;
  gold: string[];
}

export const DEV_SIZE = 10;
export const TEST_SIZE = 30;
const MAX_GOLD = 5;
const NOT_A_TASK = /\b(bump|release|version|changelog|typo|readme|docs?|merge|revert|format(ting)?|lint|ci|deps|dependabot|prettier|rename|cleanup|refactor|chore|wip|update .*\.md)\b/i;

/** Drops a conventional-commit prefix and a trailing PR number: "fix(jsx): handle x (#12)" -> "handle x". */
export function taskText(subject: string): string {
  return subject.replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\(#\d+\)\s*$/, "").trim();
}

function mine(name: string, head: string): { dev: Task[]; test: Task[]; eligible: number } {
  const repo = repoDir(name);
  const log = git(repo, ["log", "--no-merges", "--format=%x01%H %P%x00%s", "--name-status", "-z", head]);
  const eligible: Task[] = [];
  for (const entry of log.split("\x01").filter(Boolean)) {
    const [header, rest = ""] = entry.split("\x00\n", 2) as [string, string?];
    const nul = header.indexOf("\x00");
    const [commit, ...parents] = header.slice(0, nul).split(" ");
    const subject = header.slice(nul + 1).split("\x00")[0]!;
    if (!commit || parents.length !== 1) continue;
    const task = taskText(subject);
    if (task.split(/\s+/).length < 4 || NOT_A_TASK.test(subject)) continue;

    const fields = rest.split("\x00").filter(Boolean);
    const modified: string[] = [];
    let other = false;
    for (let i = 0; i < fields.length; i++) {
      const status = fields[i]!;
      const file = fields[++i]!;
      if (status.startsWith("R") || status.startsWith("C")) i++;
      if (!isSourcePath(file)) continue;
      if (status === "M") modified.push(file);
      else other = true;
    }
    // Tasks that add, delete or move source files are out of scope: there is nothing there yet to find.
    if (other || modified.length === 0 || modified.length > MAX_GOLD || modified.every(isTest)) continue;
    eligible.push({ id: `${name}-${commit.slice(0, 10)}`, repo: name, commit, parent: parents[0]!, task, gold: modified });
  }
  // A fixed pseudo-random order spreads tasks across the history without favouring recent commits.
  const order = eligible.map((t) => ({ t, key: createHash("sha256").update(t.commit).digest("hex") })).sort((a, b) => (a.key < b.key ? -1 : 1));
  const picked: Task[] = [];
  for (const { t } of order) {
    if (picked.length === DEV_SIZE + TEST_SIZE) break;
    if (goldReadable(repo, t)) picked.push(t);
  }
  return { dev: picked.slice(0, DEV_SIZE), test: picked.slice(DEV_SIZE), eligible: eligible.length };
}

/** Every answer file must be a candidate at the parent commit, or the task can't be scored fairly. */
function goldReadable(repo: string, t: Task): boolean {
  const listing = git(repo, ["ls-tree", "-l", "-z", t.parent, "--", ...t.gold]).split("\0").filter(Boolean);
  return listing.length === t.gold.length && listing.every((line) => {
    const [mode, type, , size] = line.split("\t")[0]!.split(/\s+/);
    return type === "blob" && mode !== "120000" && Number(size) <= MAX_BYTES;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(TASKS, { recursive: true });
  for (const r of REPOS) {
    const { dev, test, eligible } = mine(r.name, r.head);
    writeFileSync(path.join(TASKS, `${r.name}.json`), JSON.stringify({ repo: r.name, url: r.url, head: r.head, eligible, dev, test }, null, 1) + "\n");
    console.log(`${r.name}: ${eligible} eligible commits, ${dev.length} dev, ${test.length} test`);
  }
}
