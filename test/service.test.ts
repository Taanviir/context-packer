import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { collect } from "../src/files.js";
import { runHook } from "../src/hook.js";
import { createServer } from "../src/mcp.js";
import { ContextPacker } from "../src/service.js";

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "cp-project-"));
  outside = mkdtempSync(path.join(tmpdir(), "cp-outside-"));
  const write = (rel: string, text: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write("src/http/Retry.kt", "package http\n/** Retries failed requests. */\nclass Retry { fun backoff() = exponentialBackoff() }\n");
  write("src/http/Client.kt", "package http\nclass Client { fun send() = Retry() }\n");
  write("src/test/RetryTest.kt", "class RetryTest { fun backoffGrows() {} }\n");
  write("src/ui/Button.tsx", "export function Button() { return null }\n");
  write("README.md", "exponential backoff retry backoff");
  write("src/big.kt", "x".repeat(100_001));
  write("src/blob.kt", Buffer.from([0x62, 0x00, 0x63]));
  write("generated/Ignored.kt", "backoff backoff backoff");
  write(".gitignore", "generated/\n");
  writeFileSync(path.join(outside, "Secret.kt"), "backoff backoff");
  symlinkSync(path.join(outside, "Secret.kt"), path.join(root, "src/Linked.kt"));
  execFileSync("git", ["init", "-q"], { cwd: root });
});

describe("collect", () => {
  it("keeps source files and drops docs, ignored, oversized, binary and linked files", async () => {
    const files = await collect(root);
    expect(files.map((f) => f.path)).toEqual(["src/http/Client.kt", "src/http/Retry.kt", "src/test/RetryTest.kt", "src/ui/Button.tsx"]);
  });

  it("honours an extension allowlist", async () => {
    expect((await collect(root, { extensions: ["tsx"] })).map((f) => f.path)).toEqual(["src/ui/Button.tsx"]);
  });
});

describe("ContextPacker", () => {
  it("packs with keywords by default and needs no key", async () => {
    const report = await new ContextPacker({}).pack({ task: "add exponential backoff to retries", root });
    expect(report.provider).toBe("keywords");
    expect(report.result.files[0]!.path).toBe("src/http/Retry.kt");
    expect(report.costUsd).toBe(0);
  });

  it("names the missing key for Jev instead of falling back", async () => {
    await expect(new ContextPacker({}).pack({ task: "add backoff", root, provider: "jev" })).rejects.toThrow("TYPESAFE_API_KEY");
  });

  it("rejects over-long Laya tasks rather than truncating them", async () => {
    await expect(new ContextPacker({}).pack({ task: "x".repeat(501), root, provider: "laya" })).rejects.toThrow("not truncated");
  });

  it("runs the Jev pipeline end to end against a fake API", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries<any>(body.questions)) {
        const text = body.state[key.replace(/^role_/, "")] ?? "";
        if (q.type === "noul") answers[key] = { noul: text.includes("Retry") ? 0.9 : 0.1 };
        else if (key === "pick") answers[key] = { probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, 1 / Object.keys(q.criteria).length])) };
        else answers[key] = { probabilities: { edit: text.includes("class Retry") ? 0.9 : 0.1, test: 0, example: 0, dependency: 0, unrelated: 0.1 } };
      }
      return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1000 } }));
    }) as unknown as typeof fetch;
    const report = await new ContextPacker({ TYPESAFE_API_KEY: "k" }, fetchImpl).pack({ task: "add exponential backoff to retries", root, provider: "jev" });
    expect(report.model).toBe("jev-latest");
    expect(report.result.files[0]!.path).toBe("src/http/Retry.kt");
    expect(report.result.files[0]!.role).toBe("edit");
    expect(report.costUsd).toBeCloseTo(report.inputTokens * 0.042 / 1e6);
  });
});

describe("hook", () => {
  it("hands Claude Code the ranked files as additional context", async () => {
    const out = await runHook(JSON.stringify({ prompt: "add exponential backoff to retries", cwd: root }), {});
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("src/http/Retry.kt");
  });

  it("stays silent for short prompts, slash commands and bad input", async () => {
    expect(await runHook(JSON.stringify({ prompt: "fix it", cwd: root }), {})).toBeNull();
    expect(await runHook(JSON.stringify({ prompt: "/review this change please now", cwd: root }), {})).toBeNull();
    expect(await runHook("not json", {})).toBeNull();
    expect(await runHook(JSON.stringify({ prompt: "add exponential backoff to retries", cwd: root }), { CONTEXT_PACKER_HOOK_PROVIDER: "jev" })).toBeNull();
  });
});

describe("MCP server", () => {
  it("serves pack_context and reports errors as tool errors", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(root, new ContextPacker({})).connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);

    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["pack_context"]);
    const ok = await client.callTool({ name: "pack_context", arguments: { task: "add exponential backoff to retries", limit: 2 } });
    const text = (ok.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("#1   src/http/Retry.kt");
    expect(text).toContain("Picked 2 of 4 files");

    const failed = await client.callTool({ name: "pack_context", arguments: { task: "add backoff", provider: "jev" } });
    expect(failed.isError).toBe(true);
    await client.close();
  });
});
