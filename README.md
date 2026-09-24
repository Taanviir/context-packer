# context-packer

[![CI](https://github.com/Taanviir/context-packer/actions/workflows/ci.yml/badge.svg)](https://github.com/Taanviir/context-packer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@taanviir/context-packer)](https://www.npmjs.com/package/@taanviir/context-packer)

Ranks the source files a coding task needs, so an agent starts with the right files instead of searching for them.
Use it from the command line, as an MCP server, or as a Claude Code hook that adds the files to every prompt.

![Keywords, then Jev, then the Claude Code hook, run on the hono repository](https://taanviir.github.io/context-packer/assets/demo.svg)

Tested on 120 real past changes from four open-source projects, where the task is the commit message and the right
answer is the files the commit changed. **Jev put 78% of the needed files in its top 10; plain keyword search put
69%.** A Jev search took 2.5 s and cost about $0.007.
[Findings](https://taanviir.github.io/context-packer/findings.html) ·
[Run explorer](https://taanviir.github.io/context-packer/explorer.html) ·
[Blog](https://taanviir.github.io/context-packer/blog/)

## Install

Needs Node 22 or newer. Without a key, everything runs on keywords.

**Claude Code plugin** (hook and MCP server together):

```
/plugin marketplace add Taanviir/context-packer
/plugin install context-packer@context-packer
```

**Command line:**

```
npx -y @taanviir/context-packer pack "describe the change" --explain
npm install -g @taanviir/context-packer
```

**MCP server** for other agents:

```
claude mcp add context-packer -- npx -y @taanviir/context-packer mcp
codex mcp add context-packer -- npx -y @taanviir/context-packer mcp
```

For Cursor, add this to `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{ "mcpServers": { "context-packer": { "command": "npx", "args": ["-y", "@taanviir/context-packer", "mcp"] } } }
```

The server exposes one tool, `pack_context(task, limit?, provider?, root?, explain?)`.

## Providers

| Provider | Needs | What it does | Needed files in its top 10 |
| --- | --- | --- | --- |
| `keywords` (default) | nothing | BM25 over paths and full source for every eligible file | 69% |
| `jev` | `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` | Two passes with TypeSafe's Jev decision model, fused with keyword rank | 78% on the same tests |
| `laya` | a local Laya server | A small local model scores a 60-file keyword shortlist, one excerpt per request | 81%, where keywords got 87% on the same two projects |

Laya keeps code on your machine but found fewer files than keyword search, which is also local.

There is no automatic fallback. Asking for Jev without a key is an error, not a keyword ranking labeled as Jev.

### How a Jev pack works

1. **Collect.** Tracked and untracked-but-not-ignored source files (`git ls-files`), or a directory walk outside git.
   Docs, config, binaries, symlinks and files over 100,000 bytes are skipped.
2. **Sketch.** Each file becomes a summary of about 300 tokens: path, package, and declarations with the first line
   of their doc comments.
3. **Wide pass.** Jev reads 60 sketches per call: "Implementing the change described in `task` requires reading or
   editing the file in `f007`." BM25 ranks full source at the same time.
4. **Narrow pass.** The top 60 from each go into a pool, and Jev reads their source (first 6,000 characters), 6 files
   per call.
5. **Fuse and compare.** Jev's probability and keyword rank count equally. One `choice` call over the top ten ("which
   file must be edited?") reorders them, and a parallel call labels files as edit, test, example or dependency when
   Jev is at least 50% sure.

A failed batch scores its files zero and is reported. If Jev's firewall rejects a batch (it happens for some source
text), the batch is halved until only the offending file is lost. If every batch fails, the pack fails.

### The hook

Agents tend to trust their own search and skip an offered tool. The hook runs before the agent reads your prompt and
adds the ranked files as context. It adds nothing for prompts under four words, slash commands, short replies such as
"thanks" or "commit that", and prompts whose distinctive words don't occur in the project. That last check is a free
keyword pass, run before any paid provider.

To install it without the plugin, put this in `.claude/settings.json`:

```json
{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "timeout": 60, "command": "npx -y @taanviir/context-packer hook"}]}]}}
```

### Which project

Without `--root`, the project is the nearest directory with a manifest (`package.json`, `go.mod`, `pyproject.toml`,
`Cargo.toml` and similar), stopping at the git root. In a monorepo, starting in `packages/web` ranks that package;
starting in `src/` ranks the repository. The MCP server and hook use `CLAUDE_PROJECT_DIR` when Claude Code sets it.

### Explain a pick

```
$ context-packer pack "Add exponential backoff with jitter to Jev HTTP retries" -p jev -n 1 --explain
0.89   src/jev.ts  (edit)
       jev 0.88 · keyword #3 · compared 0.93 · edit 0.98 · words: jev×41 backoff×12 retries×6 exponential×3 jitter×3
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTEXT_PACKER_PROVIDER` | `keywords` | Provider when none is given |
| `TYPESAFE_API_KEY` | | Jev through TypeSafe's API |
| `AI_GATEWAY_API_KEY` | | Jev through Vercel AI Gateway, which rate-limits hard under load |
| `JEV_BACKEND` | `auto` | `auto` (TypeSafe key first), `typesafe` or `gateway` |
| `CONTEXT_PACKER_TOKEN_BUDGET` | `20000000` | Reported Jev input tokens per process before new packs are refused. Checked between packs, so it isn't a hard cap |
| `CONTEXT_PACKER_COMPARE_TOP` | `1` | `0` turns off the top-ten comparison |
| `CONTEXT_PACKER_ROLES` | `1` | `0` turns off role labels |
| `CONTEXT_PACKER_LAYA_URL` | `http://127.0.0.1:8770/api/predict` | Local Laya endpoint. Loopback HTTP only |
| `CONTEXT_PACKER_LAYA_MODEL` | `english` | Laya model ID |
| `CONTEXT_PACKER_EXTENSIONS` | all supported | Extension allowlist, such as `kt,kts` |
| `CONTEXT_PACKER_HOOK_PROVIDER` | `keywords` | Provider the hook uses |
| `CONTEXT_PACKER_HOOK_LIMIT` | `8` | Files the hook adds, 1 to 20 |
| `CONTEXT_PACKER_HOOK_DEADLINE` | `25` | Seconds before the hook gives up. For CPU Laya, use 180 and a hook timeout of at least 190 |

The Laya provider POSTs one file per request to the local endpoint, one request at a time:

```json
{"model": "english", "state": "File: src/jev.ts\n<excerpt>", "questions": {"relevant": {"type": "noul", "instructions": "..."}}}
```

It expects `{"answers": {"relevant": {"noul": 0.42}}}`, with optional `usage.input_tokens`.

## Benchmark

Each test is a real commit: the message is the task, and the files it changed are the answer. The tool sees the
project as it was before the commit. The score is the share of needed files that land in the top 10. Six projects are
pinned: hono, rich, gin and prometheus (keywords and Jev), plus httpx and ripgrep (keywords). Laya ran on gin and
httpx. Decisions were made on 10 changes per project; the reported numbers are 30 other changes per project, run once.
The difference between Jev and keywords is very likely between 4 and 15 more needed files per 100 (a 95% bootstrap
interval).

```
pnpm tsx bench/mine.ts                # freeze tasks from pinned history (repos cloned into bench/.cache/repos)
pnpm tsx bench/run.ts jev test        # run a provider; Jev responses are cached by request
pnpm tsx bench/report.ts              # bench/results/summary.json and runs.json, with paired bootstrap intervals
```

What was tried and didn't ship: per-language file summaries for TypeScript, Python, Go and Rust
(`bench/lang-sketch.ts`) found as many files as the simple ones, within half a file per 100, and cost up to 58% more.

## Limits

- Commit messages are shorter and vaguer than most requests to an agent, and finding the right files isn't finishing
  the task: the benchmark doesn't measure whether an agent then makes the right change.
- Tasks that mostly add new files are out of scope, because there is nothing to find yet.
- Keyword packs read every file each time. On a 14,004-file VS Code checkout that takes 3.5 s and about 620 MB.
  A Jev pack there would send about 230 sketch requests; it wasn't measured.
- Jev sends file sketches and source excerpts to TypeSafe or Vercel. Use `keywords` or `laya` for code that must stay
  local.

## Development

```
pnpm install
pnpm test         # unit tests; CONTEXT_PACKER_LAYA_LIVE=1 also runs against a local Laya server
pnpm typecheck
pnpm build        # dist/cli.js
node scripts/demo-cast.mjs <repo> > demo.cast   # re-record the README demo
```

Releases: bump `version` in `package.json` and `.claude-plugin/`, tag `vX.Y.Z`, push the tag. The release workflow
publishes to npm with provenance and creates the GitHub release.

## Acknowledgements

Thanks to [@aikram42](https://github.com/aikram42) and [@mahahahad](https://github.com/mahahahad), who built the
original context engine and its evaluation together with [@Taanviir](https://github.com/Taanviir).

MIT licensed.
