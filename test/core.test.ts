import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rankBm25, tokens } from "../src/bm25.js";
import { isTest, pack, packKeywords, ScorerUnavailableError, type FileDoc, type Items, type Scorer } from "../src/packer.js";
import { layaSketch, sketch } from "../src/sketch.js";

type Fixture = { cases: Array<{ path: string; text: string; sketch: string }> };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("sketch", () => {
  it("matches the Python sketcher the Jev evaluation measured", () => {
    for (const c of fixture("regex_parity.json").cases) expect(sketch(c.path, c.text), c.path).toBe(c.sketch);
  });

  it("matches the Laya benchmark's sketcher", () => {
    for (const c of fixture("laya_regex_parity.json").cases) expect(layaSketch(c.path, c.text), c.path).toBe(c.sketch);
  });
});

describe("bm25", () => {
  it("splits camelCase, snake_case and acronyms", () => {
    expect(tokens("cachedContentTokenCount parse_HTTPResponse x")).toEqual(["cached", "content", "token", "count", "parse", "http", "response"]);
  });

  it("ranks the file with the task's words first, ties by path", () => {
    const docs = new Map([
      ["b.kt", "nothing here"],
      ["a.kt", "nothing here"],
      ["retry.kt", "fun retryWithBackoff() = exponential backoff"],
    ]);
    expect(rankBm25("add exponential backoff to retries", docs)).toEqual(["retry.kt", "a.kt", "b.kt"]);
  });

  it("keyword packs expose ordinal ranks only", () => {
    const result = packKeywords("backoff", new Map([["x/RetryTest.kt", "backoff"], ["y.kt", ""]]), 5);
    expect(result.files.map((f) => [f.path, f.bm25Rank, f.score, f.isTest])).toEqual([["x/RetryTest.kt", 1, 0, true], ["y.kt", 2, 0, false]]);
  });
});

describe("isTest", () => {
  it.each([
    ["src/test/kotlin/Foo.kt", true],
    ["src/FooTest.kt", true],
    ["src/foo.test.ts", true],
    ["pkg/test_foo.py", true],
    ["src/contest.kt", false],
    ["src/Foo.kt", false],
  ])("%s -> %s", (path, expected) => expect(isTest(path)).toBe(expected));
});

const docs = (n: number): FileDoc[] => Array.from({ length: n }, (_, i) => ({
  path: `src/F${String(i).padStart(2, "0")}.kt`, sketch: `sketch ${i}`, text: i === 7 ? "backoff retry" : `file ${i}`,
}));

/** Relevance is 0.9 for files whose text mentions "backoff", else 0.1. */
function fakeScorer(overrides: Partial<Scorer> = {}): Scorer & { calls: Items[] } {
  const calls: Items[] = [];
  return {
    calls,
    async score(_task, items) {
      calls.push(items);
      return new Map(items.map(([p, t]) => [p, t.includes("backoff") || p.endsWith("F03.kt") ? 0.9 : 0.1]));
    },
    ...overrides,
  };
}

const small = { batch: 4, pool: 3, perCall: 2, fullChars: 100, bm25Weight: 1, keep: 5, stage3K: 3, stage3Weight: 2, overlapPasses: true, requireFullSourceScores: false };

describe("pack", () => {
  it("pools BM25's and the sketch pass's top files, then fuses full-source scores with keyword rank", async () => {
    const scorer = fakeScorer();
    const result = await pack("add backoff", docs(12), scorer, small);
    expect(result.files[0]!.path).toBe("src/F07.kt");
    expect(result.files.map((f) => f.path)).toContain("src/F03.kt");
    expect(result.failedBatches).toBe(0);
    expect(scorer.calls[0]!.length).toBe(4);
  });

  it("stage 3 can reorder the top files", async () => {
    const scorer = fakeScorer({
      async choose(_task, items) { return new Map(items.map(([p]) => [p, p.endsWith("F03.kt") ? 1 : 0])); },
    });
    const result = await pack("add backoff", docs(12), scorer, small);
    expect(result.files[0]!.path).toBe("src/F03.kt");
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
        return new Map(items.map(([p]) => [p, new Map(p.endsWith("F07.kt") ? [["edit", 0.8], ["unrelated", 0.2]] : [["example", 0.4], ["unrelated", 0.6]])]));
      },
    });
    const result = await pack("add backoff", docs(12), scorer, small);
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    expect(byPath.get("src/F07.kt")!.role).toBe("edit");
    expect(result.files.filter((f) => f.role).length).toBe(1);
  });

  it("rejects scorers that answer for the wrong files", async () => {
    const wrong: Scorer = { score: async () => new Map([["other", 0.5]]) };
    await expect(pack("add backoff", docs(3), wrong, small)).rejects.toThrow("exactly the requested paths");
  });
});
