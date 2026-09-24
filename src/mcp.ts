import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderText } from "./render.js";
import { ContextPacker, PROVIDERS } from "./service.js";
import { VERSION } from "./version.js";

const DESCRIPTION = `Locate the source files a coding task needs when you don't yet know where to edit.
Returns ranked project-relative paths with test files marked; Jev can also label top files as likely
edit, test, example or dependency. It reads files but never edits them.
provider=keywords is full-corpus BM25 with no model or API key. provider=jev re-ranks with TypeSafe's
Jev decision model (needs TYPESAFE_API_KEY). provider=laya scores a 60-file keyword shortlist with a local
Laya server. Scores are ranking signals, not correctness confidence. Read the picks before editing.`;

export function createServer(defaultRoot: string, packer = new ContextPacker()): McpServer {
  const server = new McpServer({ name: "context-packer", version: VERSION });
  server.registerTool(
    "pack_context",
    {
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().min(1).describe("The change you are about to make, in a sentence or two, e.g. \"Add exponential backoff to HTTP retries\""),
        limit: z.number().int().min(1).max(20).default(10).describe("How many files to return, 1 to 20"),
        provider: z.enum(PROVIDERS).optional().describe("keywords (local BM25), jev (API key required) or laya (local model). Defaults to CONTEXT_PACKER_PROVIDER, then keywords."),
        root: z.string().optional().describe("Absolute project directory. Defaults to the project the server was started in."),
        explain: z.boolean().default(false).describe("Add why each file was picked: matched task words, keyword rank and model scores"),
        code: z.number().int().min(0).max(10).default(0).describe("Also return the most relevant lines of the top N files, up to about 8,000 characters in all"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ task, limit, provider, root, explain, code }) => {
      const dir = path.resolve(defaultRoot, root ?? ".");
      try {
        const report = await packer.pack({ task, root: dir, limit, code, ...(provider ? { provider } : {}) });
        return { content: [{ type: "text", text: renderText(report, limit, dir, { explain }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], isError: true };
      }
    },
  );
  return server;
}

export async function serveStdio(root: string): Promise<void> {
  await createServer(root).connect(new StdioServerTransport());
}
