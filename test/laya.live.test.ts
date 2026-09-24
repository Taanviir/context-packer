import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LayaScorer } from "../src/laya.js";
import { ContextPacker } from "../src/service.js";

// Needs a running Laya server: CONTEXT_PACKER_LAYA_LIVE=1 npx vitest run test/laya.live.test.ts
describe.skipIf(!process.env.CONTEXT_PACKER_LAYA_LIVE)("Laya against a real server", () => {
  it("scores the file about the task above an unrelated one", async () => {
    const scores = await new LayaScorer({ endpoint: process.env.CONTEXT_PACKER_LAYA_URL }).score("Add exponential backoff to HTTP retries", [
      ["src/retry.ts", "export async function retry(fn) { for (let i = 0; ; i++) { try { return await fn(); } catch { await sleep(2 ** i * 100); } } }"],
      ["src/colors.ts", "export const palette = { red: '#f00', green: '#0f0', blue: '#00f' };"],
    ]);
    for (const p of scores.values()) expect(p).toBeGreaterThanOrEqual(0);
    expect(scores.get("src/retry.ts")!).toBeGreaterThan(scores.get("src/colors.ts")!);
  }, 120_000);

  it("runs a full pack", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cp-laya-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/retry.ts"), "/** Retries with exponential backoff. */\nexport async function retry(fn) {}\n");
    writeFileSync(path.join(root, "src/colors.ts"), "export const palette = {};\n");
    const report = await new ContextPacker(process.env).pack({ task: "Add jitter to the retry backoff", root, provider: "laya" });
    expect(report.provider).toBe("laya");
    expect(report.failedCalls).toBe(0);
    expect(report.result.files.map((f) => f.path)).toContain("src/retry.ts");
  }, 300_000);
});
