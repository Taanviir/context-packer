# context-packer

Ranks the source files a coding task needs, so an agent starts with the right files instead of searching for them.
Use it from the command line, as an MCP server, or as a Claude Code hook that adds the files to every prompt.

This is a standalone port of the context engine from the
[IntelliJev hackathon plugin](https://github.com/Taanviir/hackathon-jetbrains-202609/tree/main/plugins/context-packer).
It runs without an IDE.

```
$ context-packer pack "Add exponential backoff with jitter to Jev HTTP retries" -p jev -n 3
Picked 3 of 52 files in 1.8 s. Paths are relative to /work/hackathon.
score  path
0.96   plugins/context-packer/src/main/kotlin/dev/contextpacker/jev/JevClient.kt  (edit)
0.39   plugins/intellijev/src/main/kotlin/dev/intellijev/core/JevClient.kt  (edit)
0.27   plugins/context-packer/src/test/kotlin/dev/contextpacker/jev/JevClientTest.kt  (test)
Provider: jev-latest; scored 52 candidates. 12 Jev requests, 90,769 input tokens, about $0.0038. ...
```

## Providers

| Provider | Needs | What it does |
| --- | --- | --- |
| `keywords` (default) | nothing | BM25 over paths and full source for every eligible file. No model calls, no cost. |
| `jev` | `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` | The measured two-pass pipeline below, using TypeSafe's Jev decision model. A pack costs a few cents at most. |
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

## Results

These numbers come from the original Kotlin plugin, measured on Koog commit history. They have not been re-measured with this port.
The sketchers here produce the plugin's output exactly on its 80 fixture files (see `test/core.test.ts`), but the file
collector differs from IntelliJ's.

| 70 held-out Koog tasks, Kotlin files | recall@5 | recall@10 | recall@20 |
| --- | --- | --- | --- |
| BM25 keywords | 0.42 | 0.53 | 0.63 |
| Jev + BM25 pipeline | 0.57 | 0.69 | 0.80 |

In an eight-task Claude Code pilot, the hook with the Jev pipeline gave 25% fewer agent turns and 38% fewer searches.
Laya did not beat full-source keyword search on its 30-task benchmark (recall@10 0.39 against 0.55).
Details are in the [evaluation report](https://taanviir.github.io/hackathon-jetbrains-202609/main/context-packer-eval/).

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

Agents often trust their own search and skip an offered tool: in testing, headless Claude Code never called
`pack_context`, even when told to. The hook avoids that by running before Claude sees the prompt and adding the ranked
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
| `AI_GATEWAY_API_KEY` | | Jev through Vercel AI Gateway. Much slower under load: it answered about 30% of calls in testing |
| `JEV_BACKEND` | `auto` | `auto` (TypeSafe key first), `typesafe` or `gateway` |
| `CONTEXT_PACKER_TOKEN_BUDGET` | `20000000` | Reported Jev input tokens per process before new packs are refused. Checked between packs, so it isn't a hard cap |
| `CONTEXT_PACKER_COMPARE_TOP` | `1` | `0` turns off stage 3 |
| `CONTEXT_PACKER_ROLES` | `1` | `0` turns off role labels |
| `CONTEXT_PACKER_LAYA_URL` | `http://127.0.0.1:8770/api/predict` | Local Laya endpoint. Loopback HTTP only |
| `CONTEXT_PACKER_LAYA_MODEL` | `english` | Laya model ID |
| `CONTEXT_PACKER_EXTENSIONS` | all supported | Extension allowlist, such as `kt` to match the published evaluation |
| `CONTEXT_PACKER_HOOK_PROVIDER` | `keywords` | Provider the hook uses |
| `CONTEXT_PACKER_HOOK_LIMIT` | `8` | Files the hook adds, 1 to 20 |
| `CONTEXT_PACKER_HOOK_DEADLINE` | `25` | Seconds before the hook gives up. For CPU Laya, use 180 and a hook timeout of at least 190 |

A Laya server that speaks this contract is in the hackathon repo:
[`tools/laya_server.py`](https://github.com/Taanviir/hackathon-jetbrains-202609/blob/main/plugins/context-packer/tools/laya_server.py),
with setup in [LAYA.md](https://github.com/Taanviir/hackathon-jetbrains-202609/blob/main/plugins/context-packer/LAYA.md).

## Limits

- Accuracy has been measured on Kotlin in one repository. The Jev sketcher keeps the declaration keywords it was measured
  with (`class`, `interface`, `object`, `fun`, `val`, `var`, `typealias`), so a Python or Go sketch has little beyond its path.
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

MIT licensed. Test fixtures in `test/fixtures/` contain excerpts of [JetBrains/koog](https://github.com/JetBrains/koog)
(Apache-2.0).
