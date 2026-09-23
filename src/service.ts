import { rankBm25 } from "./bm25.js";
import { collect, type SourceFile } from "./files.js";
import { JEV_INPUT_PRICE, JevClient, JevScorer, type CallStat, type JevBackend } from "./jev.js";
import { LAYA_MAX_TASK_CHARS, LayaScorer } from "./laya.js";
import { DEFAULT_PACK_CONFIG, pack, packKeywords, type FileDoc, type PackConfig, type PackResult } from "./packer.js";
import { layaSketch, sketch } from "./sketch.js";

export const PROVIDERS = ["keywords", "jev", "laya"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface PackRequest {
  task: string;
  root: string;
  provider?: Provider;
  limit?: number;
  onProgress?: (message: string) => void;
}

export interface PackReport {
  provider: Provider;
  model: string;
  result: PackResult;
  /** Files ranked or scored. Laya scores only its keyword shortlist. */
  scored: number;
  collectMs: number;
  totalMs: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  /** Null when any call's usage is unknown: unknown usage is not zero. */
  costUsd: number | null;
}

export class MissingKeyError extends Error {
  override name = "MissingKeyError";
}

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
}

const TASK_LIMIT = 8_000;
const LAYA_SHORTLIST = 60;
const LAYA_CONFIG: PackConfig = {
  ...DEFAULT_PACK_CONFIG, batch: 1, pool: 20, perCall: 1, fullChars: 1_000, overlapPasses: false, requireFullSourceScores: true,
};

/**
 * Holds the Jev client across packs so the session token budget covers a long-lived MCP server,
 * not only one CLI call.
 */
export class ContextPacker {
  private jev: JevClient | null = null;
  private jevKey = "";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetchImpl?: typeof fetch) {}

  defaultProvider(): Provider {
    const configured = this.env.CONTEXT_PACKER_PROVIDER?.trim().toLowerCase();
    if (!configured) return "keywords";
    return parseProvider(configured);
  }

  async pack(request: PackRequest): Promise<PackReport> {
    const provider = request.provider ?? this.defaultProvider();
    const task = request.task.trim();
    if (!task) throw new RangeError("Task must not be blank");
    const taskLimit = provider === "laya" ? LAYA_MAX_TASK_CHARS : TASK_LIMIT;
    if (task.length > taskLimit) {
      throw new RangeError(`${provider} supports tasks up to ${taskLimit} characters. The task was not truncated; shorten it or choose another provider.`);
    }
    const keep = request.limit ?? 20;
    if (!Number.isInteger(keep) || keep < 1 || keep > 50) throw new RangeError("limit must be between 1 and 50");
    const progress = request.onProgress ?? (() => {});

    const started = performance.now();
    progress("Collecting source files");
    const files = await collect(request.root);
    const collectMs = Math.round(performance.now() - started);
    if (files.length === 0) throw new RangeError(`No source files found under ${request.root}`);

    if (provider === "keywords") {
      const result = packKeywords(task, new Map(files.map((f) => [f.path, f.text])), keep);
      return report(provider, "bm25", result, files.length, collectMs, started, []);
    }

    if (provider === "jev") {
      const client = this.jevClient();
      const budget = Number(this.env.CONTEXT_PACKER_TOKEN_BUDGET || 20_000_000);
      if (!Number.isFinite(budget) || budget <= 0) throw new RangeError("CONTEXT_PACKER_TOKEN_BUDGET must be a positive number");
      if (client.inputTokens >= budget) {
        throw new BudgetExceededError(`This session has used ${client.inputTokens} reported Jev input tokens, over the ${budget} budget. Set CONTEXT_PACKER_TOKEN_BUDGET to raise it.`);
      }
      const before = client.calls.length;
      const docs = files.map((f): FileDoc => ({ ...f, sketch: sketch(f.path, f.text) }));
      const scorer = new JevScorer(client, {
        compareTop: this.env.CONTEXT_PACKER_COMPARE_TOP !== "0",
        assignRoles: this.env.CONTEXT_PACKER_ROLES !== "0",
      });
      const result = await pack(task, docs, scorer, { ...DEFAULT_PACK_CONFIG, keep }, progress);
      return report(provider, client.model, result, docs.length, collectMs, started, client.calls.slice(before));
    }

    const laya = new LayaScorer({
      endpoint: this.env.CONTEXT_PACKER_LAYA_URL?.trim(),
      model: this.env.CONTEXT_PACKER_LAYA_MODEL?.trim(),
      fetch: this.fetchImpl,
    });
    // Laya is a small local encoder: bound its CPU work with a keyword shortlist and say so in the report.
    const shortlist = shortlistFor(task, files, LAYA_SHORTLIST);
    const docs = shortlist.map((f): FileDoc => ({ ...f, sketch: layaSketch(f.path, f.text) }));
    const scored = await pack(task, docs, laya, { ...LAYA_CONFIG, keep }, progress);
    const result = { ...scored, candidates: files.length };
    return report(provider, `laya/${laya.model}`, result, docs.length, collectMs, started, laya.calls);
  }

  /**
   * TypeSafe's own API by default. Vercel AI Gateway with `JEV_BACKEND=gateway`, or when only a gateway key
   * is set; it serves the same model but rate-limits hard, so a pack can take 30-60 s.
   */
  private jevClient(): JevClient {
    const typesafe = this.env.TYPESAFE_API_KEY?.trim();
    const gateway = this.env.AI_GATEWAY_API_KEY?.trim();
    const wanted = this.env.JEV_BACKEND?.trim().toLowerCase() || "auto";
    let key: string | undefined;
    let backend: JevBackend;
    if (wanted === "typesafe") [key, backend] = [typesafe, "typesafe"];
    else if (wanted === "gateway") [key, backend] = [gateway, "gateway"];
    else if (wanted === "auto") [key, backend] = typesafe ? [typesafe, "typesafe"] : [gateway, "gateway"];
    else throw new RangeError("JEV_BACKEND must be auto, typesafe or gateway");
    if (!key) {
      throw new MissingKeyError(wanted === "gateway" ? "Set AI_GATEWAY_API_KEY to use Jev through Vercel AI Gateway."
        : wanted === "typesafe" ? "Set TYPESAFE_API_KEY to use Jev." : "Set TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY) to use Jev.");
    }
    if (this.jev && this.jevKey === key && this.jev.backend === backend) return this.jev;
    const previous = this.jev?.calls ?? [];
    this.jev = new JevClient({ apiKey: key, backend, ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}) });
    // A new key keeps the session's reported usage, so the budget can't be reset by swapping keys.
    this.jev.calls.push(...previous);
    this.jevKey = key;
    return this.jev;
  }
}

export function parseProvider(value: string): Provider {
  const v = value.trim().toLowerCase();
  if (v === "bm25") return "keywords";
  if ((PROVIDERS as readonly string[]).includes(v)) return v as Provider;
  throw new RangeError(`provider must be one of ${PROVIDERS.join(", ")}`);
}

function shortlistFor(task: string, files: SourceFile[], limit: number): SourceFile[] {
  if (files.length <= limit) return files;
  const byPath = new Map(files.map((f) => [f.path, f]));
  return rankBm25(task, new Map(files.map((f) => [f.path, f.text]))).slice(0, limit).map((p) => byPath.get(p)!);
}

function report(
  provider: Provider, model: string, result: PackResult, scored: number, collectMs: number, started: number, calls: CallStat[],
): PackReport {
  const inputTokens = calls.reduce((sum, c) => sum + c.inputTokens, 0);
  return {
    provider,
    model,
    result,
    scored,
    collectMs,
    totalMs: Math.round(performance.now() - started),
    calls: calls.length,
    failedCalls: calls.filter((c) => c.error !== null).length,
    inputTokens,
    costUsd: provider === "keywords" || provider === "laya" ? 0
      : calls.every((c) => c.usageKnown) ? inputTokens * JEV_INPUT_PRICE / 1_000_000 : null,
  };
}
