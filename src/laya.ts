import type { CallStat } from "./jev.js";
import { ScorerUnavailableError, type Items, type Scorer } from "./packer.js";

export const DEFAULT_LAYA_ENDPOINT = "http://127.0.0.1:8770/api/predict";
export const LAYA_MAX_EXCERPT_CHARS = 1_000;
export const LAYA_MAX_TASK_CHARS = 500;

export class LayaError extends Error {
  override name = "LayaError";
}

export interface LayaOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  maxExcerptChars?: number;
  fetch?: typeof fetch;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Adapter for the Laya playground's local /api/predict contract. No cloud fallback and no API key. */
export class LayaScorer implements Scorer {
  readonly model: string;
  readonly calls: CallStat[] = [];
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly maxExcerptChars: number;
  private readonly fetch: typeof fetch;

  constructor(options: LayaOptions = {}) {
    const endpoint = options.endpoint || DEFAULT_LAYA_ENDPOINT;
    let url: URL | null = null;
    try {
      url = new URL(endpoint);
    } catch {}
    if (!url || url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password || url.hash) {
      throw new RangeError(`Laya needs a local HTTP endpoint, e.g. ${DEFAULT_LAYA_ENDPOINT} (no credentials or fragment).`);
    }
    this.url = url;
    this.model = options.model || "english";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.model)) throw new RangeError("Laya model ID must be 1-64 letters, digits, dots, underscores or hyphens.");
    this.maxExcerptChars = options.maxExcerptChars ?? LAYA_MAX_EXCERPT_CHARS;
    if (this.maxExcerptChars < 1 || this.maxExcerptChars > LAYA_MAX_EXCERPT_CHARS) {
      throw new RangeError(`Laya excerpt size must be between 1 and ${LAYA_MAX_EXCERPT_CHARS} characters.`);
    }
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * Laya's English encoder has a 512-token window, and combining files in one state silently drops later
   * candidates. So each request holds exactly one short excerpt, and requests run one at a time.
   */
  async score(task: string, items: Items): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    for (const [path, text] of items) scores.set(path, await this.predict(task, path, text));
    return scores;
  }

  private async predict(task: string, path: string, text: string): Promise<number> {
    const body = {
      model: this.model,
      state: `File: ${path.slice(0, 240)}\n${text.slice(0, this.maxExcerptChars)}`,
      questions: {
        relevant: {
          type: "noul",
          instructions: `This source file is relevant to implementing the following coding task: ${task.slice(0, LAYA_MAX_TASK_CHARS)}`,
        },
      },
    };
    const started = performance.now();
    const record = (inputTokens: number, error: string | null, usageKnown: boolean) =>
      this.calls.push({ ms: Math.round(performance.now() - started), inputTokens, questions: 1, error, usageKnown });
    let response: Response;
    let raw: string;
    try {
      response = await this.fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      raw = await response.text();
    } catch (error) {
      const message = `Could not reach local Laya at ${this.url} (${(error as Error).name}). Start the server, then pack again.`;
      record(0, message, false);
      throw new ScorerUnavailableError(message);
    }
    if (response.status !== 200) {
      const message = `Local Laya returned HTTP ${response.status}. Check its server log and model readiness, then pack again.`;
      record(0, message, false);
      throw new ScorerUnavailableError(message);
    }
    let root: Record<string, any>;
    try {
      root = JSON.parse(raw);
    } catch {
      record(0, "invalid JSON", false);
      throw new LayaError("Local Laya returned invalid JSON.");
    }
    const tokens = root?.usage?.input_tokens;
    const known = typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0;
    const p = root?.answers?.relevant?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      record(known ? tokens : 0, "no valid probability", known);
      throw new LayaError("Local Laya returned no valid relevance probability.");
    }
    record(known ? tokens : 0, null, known);
    return p;
  }
}
