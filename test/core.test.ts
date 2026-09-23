import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rankBm25, tokens } from "../src/bm25.js";
import { isTest, pack, packKeywords, ScorerUnavailableError, type FileDoc, type Items, type Scorer } from "../src/packer.js";
import { layaSketch, sketch } from "../src/sketch.js";

type Case = { file: string; path: string; jev: string; laya: string };
const fixtures = new URL("./fixtures/", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(new URL("sketches.json", fixtures), "utf8")).cases;
const source = (c: Case) => readFileSync(new URL(`sketch-sources/${c.file}`, fixtures), "utf8");

// Expected output comes from fixtures/make_sketches.py, a separate Python implementation.
describe("sketch", () => {
  it.each(cases.map((c) => [c.file, c] as const))("jev sketch of %s", (_, c) => expect(sketch(c.path, source(c))).toBe(c.jev));
  it.each(cases.map((c) => [c.file, c] as const))("laya sketch of %s", (_, c) => expect(layaSketch(c.path, source(c))).toBe(c.laya));
});

describe("bm25", () => {
  it("splits camelCase, snake_case and acronyms", () => {
    expect(tokens("cachedContentTokenCount parse_HTTPResponse x")).toEqual(["cached", "content", "token", "count", "parse", "http", "response"]);
  });

  it("ranks the file with the task's words first, ties by path", () => {
    const docs = new Map([
      ["b.py", "nothing here"],
      ["a.py", "nothing here"],
      ["retry.py", "def retry_with_backoff(): exponential backoff"],
    ]);
    expect(rankBm25("add exponential backoff to retries", docs)).toEqual(["retry.py", "a.py", "b.py"]);
  });

  it("keyword packs expose ordinal ranks only", () => {
    const result = packKeywords("backoff", new Map([["x/retry_test.go", "backoff"], ["y.go", ""]]), 5);
    expect(result.files.map((f) => [f.path, f.bm25Rank, f.score, f.isTest])).toEqual([["x/retry_test.go", 1, 0, true], ["y.go", 2, 0, false]]);
  });
});

describe("isTest", () => {
  it.each([
    ["tests/unit/cache.py", true],
    ["src/FooTests.cs", true],
    ["src/foo.test.ts", true],
    ["pkg/test_foo.py", true],
    ["src/contest.ts", false],
    ["src/server_test.go", true],
    ["src/foo.rs", false],
  ])("%s -> %s", (path, expected) => expect(isTest(path)).toBe(expected));
});

const docs = (n: number): FileDoc[] => Array.from({ length: n }, (_, i) => ({
  path: `src/F${String(i).padStart(2, "0")}.ts`, sketch: `sketch ${i}`, text: i === 7 ? "backoff retry" : `file ${i}`,
}));

/** Relevance is 0.9 for files whose text mentions "backoff", else 0.1. */
function fakeScorer(overrides: Partial<Scorer> = {}): Scorer & { calls: Items[] } {
  const calls: Items[] = [];
  return {
    calls,
    async score(_task, items) {
      calls.push(items);
      return new Map(items.map(([p, t]) => [p, t.includes("backoff") || p.endsWith("F03.ts") ? 0.9 : 0.1]));
    },
    ...overrides,
  };
}

const small = { batch: 4, pool: 3, perCall: 2, fullChars: 100, bm25Weight: 1, keep: 5, stage3K: 3, stage3Weight: 2, overlapPasses: true, requireFullSourceScores: false };

describe("pack", () => {
  it("pools BM25's and the sketch pass's top files, then fuses full-source scores with keyword rank", async () => {
    const scorer = fakeScorer();
    const result = await pack("add backoff", docs(12), scorer, small);
    expect(result.files[0]!.path).toBe("src/F07.ts");
    expect(result.files.map((f) => f.path)).toContain("src/F03.ts");
    expect(result.failedBatches).toBe(0);
    expect(scorer.calls[0]!.length).toBe(4);
  });

  it("stage 3 can reorder the top files", async () => {
    const scorer = fakeScorer({
      async choose(_task, items) { return new Map(items.map(([p]) => [p, p.endsWith("F03.ts") ? 1 : 0])); },
    });
    const result = await pack("add backoff", docs(12), scorer, small);
    expect(result.files[0]!.path).toBe("src/F03.ts");
  });

  it("a failed batch costs its files a zero, not the pack", async () => {
    let n = 0;
    const scorer = fakeScorer();
    const flaky: Scorer = { score: (task, items) => (n++ === 1 ? Promise.reject(new Error("503")) : scorer.score(task, items)) };
    const result = await pack("add backoff", docs(12), flaky, small);
    expect(result.failedBatches).toBe(1);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("refuses to pass off a keyword ranking as a model ranking when every sketch batch fails", async () => {
    await expect(pack("add backoff", docs(12), { score: () => Promise.reject(new Error("down")) }, small)).rejects.toThrow("down");
  });

  it("aborts on a provider-wide outage", async () => {
    const down: Scorer = { score: () => Promise.reject(new ScorerUnavailableError("no server")) };
    await expect(pack("add backoff", docs(12), down, small)).rejects.toThrow("no server");
  });

  it("labels roles only above the confidence threshold", async () => {
    const scorer = fakeScorer({
      async roles(_task, items) {
        return new Map(items.map(([p]) => [p, new Map(p.endsWith("F07.ts") ? [["edit", 0.8], ["unrelated", 0.2]] : [["example", 0.4], ["unrelated", 0.6]])]));
      },
    });
    const result = await pack("add backoff", docs(12), scorer, small);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(byPath.get("src/F07.ts")!.role).toBe("edit");
    expect(result.files.filter((f) => f.role).length).toBe(1);
  });

  it("rejects scorers that answer for the wrong files", async () => {
    const wrong: Scorer = { score: async () => new Map([["other", 0.5]]) };
    await expect(pack("add backoff", docs(3), wrong, small)).rejects.toThrow("exactly the requested paths");
  });
});
