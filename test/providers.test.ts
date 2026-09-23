import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JevClient, JevScorer, parseJevResponse } from "../src/jev.js";
import { LayaScorer } from "../src/laya.js";
import { ScorerUnavailableError } from "../src/packer.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

type Sent = { url: string; headers: Record<string, string>; body: any };

function fakeFetch(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
    const next = responses.shift() ?? { status: 500, body: "{}" };
    return new Response(next.body, { status: next.status, headers: next.headers ?? {} });
  }) as typeof fetch;
  return { sent, impl };
}

describe("Jev", () => {
  it("asks one noul question per file and reads the probabilities", async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: fixture("systemone_noul.json") }]);
    const client = new JevClient({ apiKey: "k", fetch: impl });
    const scores = await new JevScorer(client).score("task", [["a.ts", "A"], ["b.ts", "B"]]);
    expect([...scores]).toEqual([["a.ts", 0.96], ["b.ts", 0.03]]);
    expect(sent[0]!.body.model).toBe("jev-latest");
    expect(sent[0]!.body.state).toEqual({ task: "task", f000: "A", f001: "B" });
    expect(sent[0]!.body.questions.f000.type).toBe("noul");
    expect(client.inputTokens).toBe(400);
  });

  it("translates noul to boolean for the gateway and reads its answers", async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: fixture("gateway_boolean.json") }]);
    const client = new JevClient({ apiKey: "k", backend: "gateway", fetch: impl });
    const scores = await new JevScorer(client).score("task", [["a.ts", "A"], ["b.ts", "B"]]);
    expect(scores.get("a.ts")).toBe(0.96);
    expect(sent[0]!.body.questions.f000.type).toBe("boolean");
    expect(sent[0]!.headers["ai-model-id"]).toBe("typesafe-ai/jev");
    expect(client.calls[0]!.inputTokens).toBe(400);
  });

  it("reads comparative choice and role probabilities", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: fixture("systemone_choice.json") },
      { status: 200, body: fixture("systemone_roles.json") },
    ]);
    const scorer = new JevScorer(new JevClient({ apiKey: "k", fetch: impl }));
    expect([...(await scorer.choose!("t", [["a", ""], ["b", ""]]))]).toEqual([["a", 0.2], ["b", 0.8]]);
    const roles = await scorer.roles!("t", [["a", ""], ["b", ""]]);
    expect(roles.get("b")!.get("test")).toBe(0.7);
  });

  it("retries 429 using retry-after, and does not retry 401", async () => {
    const { sent, impl } = fakeFetch([
      { status: 429, body: "{}", headers: { "retry-after-ms": "1" } },
      { status: 200, body: fixture("systemone_noul.json") },
    ]);
    const client = new JevClient({ apiKey: "k", fetch: impl });
    await new JevScorer(client).score("t", [["a", ""], ["b", ""]]);
    expect(sent.length).toBe(2);

    const denied = fakeFetch([{ status: 401, body: "no" }]);
    const rejected = new JevClient({ apiKey: "k", fetch: denied.impl });
    await expect(new JevScorer(rejected).score("t", [["a", ""]])).rejects.toThrow("rejected the API key");
    expect(denied.sent.length).toBe(1);
  });

  it("treats missing usage as unknown, not zero", () => {
    expect(parseJevResponse('{"answers":{}}').usageKnown).toBe(false);
  });
});

describe("Laya", () => {
  it("only accepts loopback HTTP endpoints", () => {
    expect(() => new LayaScorer({ endpoint: "https://example.com/api/predict" })).toThrow("local HTTP endpoint");
    expect(() => new LayaScorer({ endpoint: "http://user:pw@127.0.0.1:8770/api/predict" })).toThrow();
    expect(() => new LayaScorer({ endpoint: "http://localhost:8770/api/predict" })).not.toThrow();
  });

  it("sends one short excerpt per request", async () => {
    const answer = JSON.stringify({ answers: { relevant: { noul: 0.4 } }, usage: { input_tokens: 90 } });
    const { sent, impl } = fakeFetch([{ status: 200, body: answer }, { status: 200, body: answer }]);
    const laya = new LayaScorer({ fetch: impl });
    const scores = await laya.score("t", [["a.ts", "x".repeat(5000)], ["b.ts", "y"]]);
    expect([...scores.values()]).toEqual([0.4, 0.4]);
    expect(sent.length).toBe(2);
    expect(sent[0]!.body.state.length).toBe("File: a.ts\n".length + 1000);
  });

  it("reports an unreachable server as a provider-wide outage", async () => {
    const impl = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(new LayaScorer({ fetch: impl }).score("t", [["a", ""]])).rejects.toBeInstanceOf(ScorerUnavailableError);
  });
});
