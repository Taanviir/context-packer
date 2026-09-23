# context-packer

Ranks the source files a coding task needs, so an agent starts with the right files instead of searching for them.
Use it from the command line, as an MCP server, or as a Claude Code hook that adds the files to every prompt.

```
$ context-packer pack "Add exponential backoff with jitter to Jev HTTP retries" -p jev -n 3
Picked 3 of 15 files in 1.7 s. Paths are relative to /home/me/context-packer.
score  path
0.93   src/jev.ts  (edit)
0.29   src/service.ts
0.28   test/service.test.ts  (test)
Provider: jev-latest; scored 15 candidates. 6 Jev requests, 49,864 input tokens, about $0.0021. ...
```

## Providers

| Provider | Needs | What it does |
| --- | --- | --- |
| `keywords` (default) | nothing | BM25 over paths and full source for every eligible file. No model calls, no cost. |
| `jev` | `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` | The two-pass pipeline below, using TypeSafe's Jev decision model. A pack costs a few cents at most. |
| `laya` | a local Laya server | Scores a 60-file keyword shortlist, one short excerpt per request, on your own machine. |

There is no automatic fallback. If you ask for Jev without a key, you get an error, not a keyword ranking labelled as Jev.

### How the Jev pipeline works

Jev answers typed questions with calibrated probabilities. It can't write code, but it can judge thousands of files quickly
and cheaply, so it does the looking and the coding agent does the editing.

1. **Collect.** Tracked and untracked-but-not-ignored source files (`git ls-files`), or a directory walk outside git.
   Docs, config, binaries, symlinks and files over 100,000 bytes are skipped.
2. **Sketch.** Each file becomes a ~300-token summary: path, package, and top-level declarations with the first line of
   their doc comments.
3. **Pass 1.** Jev reads 60 sketches per call: "Implementing the change described in `task` requires reading or editing
   the file in `f007`." BM25 ranks full source at the same time.
4. **Pool.** The top 60 from each.
5. **Pass 2.** The same question over the full source (first 6,000 characters) of the pool, 6 files per call.
6. **Fuse.** Jev's probability plus BM25 rank, weighted equally.
7. **Stage 3.** One `choice` call over the top 10, "which file must be edited?", reorders them. A parallel call labels
   each as edit, test, example or dependency when Jev is at least 50% sure.

A failed batch scores its files zero and is reported. If every batch fails, the pack fails.

## Install

Needs Node 22 or newer.

```
git clone https://github.com/Taanviir/context-packer.git
cd context-packer && npm install && npm link
```

## Use it

### Command line

```
context-packer pack "<task>" [--root DIR] [--provider keywords|jev|laya] [--limit N] [--json]
```

`--json` prints the full report: scores, BM25 ranks, roles, stage timings, request count, tokens and cost.

### MCP server

```
claude mcp add context-packer -- context-packer mcp
```

This adds one tool, `pack_context(task, limit?, provider?, root?)`. `root` defaults to the directory the server started
in. The server keeps a single Jev client, so the token budget covers the whole session.

### Claude Code hook

Agents often trust their own search and skip an offered tool, even when told to use it. The hook avoids that by running before Claude sees the prompt and adding the ranked
files as context. Put this in `.claude/settings.json` or `.claude/settings.local.json`:

```json
{"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "timeout": 60, "command": "context-packer hook"}]}]}}
```

Prompts under four words and slash commands are skipped. The hook stops after `CONTEXT_PACKER_HOOK_DEADLINE` seconds
(default 25). It adds nothing if anything fails, so it never blocks a prompt.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTEXT_PACKER_PROVIDER` | `keywords` | Provider for `pack` and `pack_context` when none is given |
| `TYPESAFE_API_KEY` | | Jev through TypeSafe's API |
| `AI_GATEWAY_API_KEY` | | Jev through Vercel AI Gateway. Rate-limits hard under load, so packs are much slower |
| `JEV_BACKEND` | `auto` | `auto` (TypeSafe key first), `typesafe` or `gateway` |
| `CONTEXT_PACKER_TOKEN_BUDGET` | `20000000` | Reported Jev input tokens per process before new packs are refused. Checked between packs, so it isn't a hard cap |
| `CONTEXT_PACKER_COMPARE_TOP` | `1` | `0` turns off stage 3 |
| `CONTEXT_PACKER_ROLES` | `1` | `0` turns off role labels |
| `CONTEXT_PACKER_LAYA_URL` | `http://127.0.0.1:8770/api/predict` | Local Laya endpoint. Loopback HTTP only |
| `CONTEXT_PACKER_LAYA_MODEL` | `english` | Laya model ID |
| `CONTEXT_PACKER_EXTENSIONS` | all supported | Extension allowlist, such as `kt` |
| `CONTEXT_PACKER_HOOK_PROVIDER` | `keywords` | Provider the hook uses |
| `CONTEXT_PACKER_HOOK_LIMIT` | `8` | Files the hook adds, 1 to 20 |
| `CONTEXT_PACKER_HOOK_DEADLINE` | `25` | Seconds before the hook gives up. For CPU Laya, use 180 and a hook timeout of at least 190 |

The Laya provider POSTs one file per request to the local endpoint and reads back a single probability:

```json
{"model": "english", "state": "File: src/jev.ts\n<excerpt>", "questions": {"relevant": {"type": "noul", "instructions": "..."}}}
```

It expects `{"answers": {"relevant": {"noul": 0.42}}}`, with optional `usage.input_tokens`.

## Limits

- Sketches are Kotlin-shaped. The Jev sketcher looks for `class`, `interface`, `object`, `fun`, `val`, `var` and
  `typealias`, so a Python or Go sketch has little beyond its path.
- Tasks that mostly add new files are out of scope, because there is nothing to find yet.
- Files are re-read on each CLI run. The MCP server caches file text by modification time.
- Jev sends file sketches and source excerpts to TypeSafe or Vercel. Use `keywords` or `laya` for code that must stay
  local.
- The Laya provider is tested against a fake server only.

## Development

```
npm install
npm test         # vitest
npm run typecheck
npm run build    # dist/cli.js
```

MIT licensed. See `test/fixtures/NOTICE` for the licence of the test fixtures.
