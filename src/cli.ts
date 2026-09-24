#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { projectRoot } from "./files.js";
import { runHook } from "./hook.js";
import { serveStdio } from "./mcp.js";
import { renderJson, renderText } from "./render.js";
import { ContextPacker, parseProvider } from "./service.js";
import { VERSION } from "./version.js";

const USAGE = `context-packer ${VERSION}: rank the source files a coding task needs.

Usage:
  context-packer pack "<task>" [--root DIR] [--provider keywords|jev|laya] [--limit N] [--code N] [--explain] [--json]
  context-packer mcp [--root DIR]     Serve the pack_context tool over MCP stdio
  context-packer hook                 Claude Code UserPromptSubmit hook (reads the payload on stdin)

Without --root, the project is the nearest directory with a manifest (package.json, go.mod, ...) up to the git root.

Environment:
  CONTEXT_PACKER_PROVIDER      Default provider (keywords)
  TYPESAFE_API_KEY             Jev through TypeSafe's API
  AI_GATEWAY_API_KEY           Jev through Vercel AI Gateway; JEV_BACKEND=auto|typesafe|gateway
  CONTEXT_PACKER_LAYA_URL      Local Laya endpoint (http://127.0.0.1:8770/api/predict)
  CONTEXT_PACKER_EXTENSIONS    Comma-separated extension allowlist, e.g. kt
  --code N adds the most relevant lines of the top N files to the output.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      provider: { type: "string", short: "p" },
      limit: { type: "string", short: "n" },
      json: { type: "boolean" },
      explain: { type: "boolean", short: "e" },
      code: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
  });
  const root = values.root ? path.resolve(values.root) : projectRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());

  switch (command) {
    case "pack": {
      const task = positionals.join(" ").trim();
      if (!task || values.help) {
        process.stderr.write(USAGE);
        return task ? 0 : 2;
      }
      const limit = Number(values.limit ?? 10);
      const packer = new ContextPacker();
      const report = await packer.pack({
        task,
        root,
        limit,
        ...(values.code ? { code: Number(values.code) } : {}),
        ...(values.provider ? { provider: parseProvider(values.provider) } : {}),
        onProgress: (m) => { if (process.stderr.isTTY) process.stderr.write(`\x1b[2K\r${m}…`); },
      });
      if (process.stderr.isTTY) process.stderr.write("\x1b[2K\r");
      process.stdout.write((values.json ? renderJson(report, limit, root) : renderText(report, limit, root, { explain: values.explain ?? false })) + "\n");
      return 0;
    }
    case "mcp":
      await serveStdio(root);
      return -1;
    case "hook": {
      const output = await runHook(await readStdin());
      if (output) process.stdout.write(output + "\n");
      return 0;
    }
    case "--version":
    case "-v":
      process.stdout.write(VERSION + "\n");
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

main(process.argv.slice(2)).then(
  // The MCP server keeps running; everything else exits even if a timed-out pack is still in flight.
  (code) => { if (code >= 0) process.exit(code); },
  (error) => {
    process.stderr.write(`context-packer: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
