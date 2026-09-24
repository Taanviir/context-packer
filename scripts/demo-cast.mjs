// Records the README demo as an asciicast: real commands, real output, real durations; only the typing is simulated.
//   node scripts/demo-cast.mjs <repo-dir> > demo.cast   (needs TYPESAFE_API_KEY for the Jev scene)
import { execFileSync } from "node:child_process";
import path from "node:path";

const repo = path.resolve(process.argv[2] ?? ".");
const cli = path.resolve(import.meta.dirname, "../dist/cli.js");
const task = "Stop writing to the SSE stream after the client aborts";
const shown = `~/${path.basename(repo)}`;

const scenes = [
  { note: "# Keywords: no key, no model", show: `context-packer pack "${task}" -n 5`, args: ["pack", task, "-n", "5"] },
  { note: "# Jev re-ranks the shortlist", show: `context-packer pack "${task}" -n 5 -p jev`, args: ["pack", task, "-n", "5", "-p", "jev"] },
  {
    note: "# The Claude Code hook runs before the agent reads your prompt",
    show: `echo '{"prompt": "${task}"}' | context-packer hook | jq -r .systemMessage`,
    args: ["hook"],
    input: JSON.stringify({ prompt: task, cwd: repo }),
    pick: (out) => JSON.parse(out).systemMessage,
  },
];

const events = [];
let t = 0.5;
const out = (text) => events.push([+t.toFixed(3), "o", text.replace(/\n/g, "\r\n")]);
const type = (text) => {
  for (const ch of text) {
    out(ch);
    t += 0.028 + (ch === " " ? 0.02 : 0);
  }
};

for (const s of scenes) {
  out("\x1b[38;5;245m");
  type(s.note);
  out("\x1b[0m\n$ ");
  t += 0.4;
  type(s.show);
  t += 0.3;
  out("\n");
  const started = performance.now();
  let text = execFileSync("node", [cli, ...s.args], { cwd: repo, input: s.input, encoding: "utf8", env: process.env });
  const seconds = (performance.now() - started) / 1000;
  if (s.pick) text = s.pick(text) + "\n";
  // Keep the pack's own report and the file list; the long provider note wraps badly at 100 columns.
  text = text.split("\n").filter((l) => !l.startsWith("Provider:")).join("\n").replaceAll(repo, shown);
  t += seconds;
  out(text.trimEnd() + "\n\n");
  t += 2.2;
}

console.log(JSON.stringify({ version: 2, width: 100, height: 28, timestamp: 0, env: { SHELL: "/bin/bash", TERM: "xterm-256color" } }));
for (const e of events) console.log(JSON.stringify(e));
