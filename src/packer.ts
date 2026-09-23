import { compare, rankBm25 } from "./bm25.js";

/** One candidate file: a short structural sketch for the wide pass, full text for the narrow one. */
export interface FileDoc {
  path: string;
  sketch: string;
  text: string;
}

export interface PackConfig {
  /** Sketches per model call in pass 1. 100 still fits Jev's ~32k-token state limit; 150 doesn't. */
  batch: number;
  /** How many of BM25's and pass 1's top files each go into the re-rank pool. */
  pool: number;
  /** Full-source files per model call in pass 2. */
  perCall: number;
  fullChars: number;
  /** Weight of BM25 position against the model's score. */
  bm25Weight: number;
  keep: number;
  /** Stage 3: how many of the top files one comparative `choice` reorders, and how much its probability counts. */
  stage3K: number;
  stage3Weight: number;
  /** Start the full-source pass over BM25's pool while sketch scoring is still running. Laya runs sequentially. */
  overlapPasses: boolean;
  /** Fail when every full-source batch fails instead of degrading to sketch and keyword scores. */
  requireFullSourceScores: boolean;
}

export const DEFAULT_PACK_CONFIG: PackConfig = {
  batch: 60,
  pool: 60,
  perCall: 6,
  fullChars: 6_000,
  bm25Weight: 1.0,
  keep: 20,
  stage3K: 10,
  stage3Weight: 2.0,
  overlapPasses: true,
  requireFullSourceScores: false,
};

export type Role = "edit" | "test" | "example" | "dependency" | "unrelated";
export const ROLE_NAMES: readonly Role[] = ["edit", "test", "example", "dependency", "unrelated"];
/** A role label shows only when the model puts at least this much probability on it. */
export const ROLE_MIN = 0.5;

export interface PackedFile {
  path: string;
  /** Model pass-2 P(relevant); 0 for keyword-only ranking. */
  relevance: number;
  /** Fused score in 0..1; 0 for keyword-only ranking. */
  score: number;
  bm25Rank: number | null;
  isTest: boolean;
  role?: Role;
  roleConfidence?: number;
}

export interface PackResult {
  task: string;
  files: PackedFile[];
  candidates: number;
  pass1Ms: number;
  pass2Ms: number;
  stage3Ms: number;
  totalMs: number;
  failedBatches: number;
}

export type Items = Array<[path: string, text: string]>;

export interface Scorer {
  /** Scores a batch in one call. Returns exactly one probability in [0, 1] per requested path. */
  score(task: string, items: Items): Promise<Map<string, number>>;
  /** One comparison across the batch: each file's probability of being the one to edit. */
  choose?(task: string, items: Items): Promise<Map<string, number>>;
  /** The role each file plays in the change, as a probability per role. */
  roles?(task: string, items: Items): Promise<Map<string, Map<string, number>>>;
}

/** A provider-wide failure: abort the pack rather than retrying the same outage for every file. */
export class ScorerUnavailableError extends Error {
  override name = "ScorerUnavailableError";
}

interface Scores {
  scores: Map<string, number>;
  failed: number;
  batches: number;
  firstFailure?: unknown;
}

const TEST_DIR = /(^|\/)[\w-]*[tT]est[\w-]*\//;
const TEST_FILE = /(Test|Tests|Spec|IT)\.[A-Za-z]+$|(\.|_)(test|spec)\.[A-Za-z]+$|(^|\/)test_[\w-]+\.py$/;

export function isTest(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

/**
 * A model alone on sketches loses to keyword search. It earns its place as a re-ranker over a pooled
 * shortlist, reading full source, with its score fused with BM25 rank.
 */
export async function pack(
  task: string,
  docs: FileDoc[],
  scorer: Scorer,
  config: PackConfig = DEFAULT_PACK_CONFIG,
  onProgress: (message: string) => void = () => {},
): Promise<PackResult> {
  validate(task, docs, config);
  const started = performance.now();
  onProgress(`Scoring ${docs.length} files`);
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const full = (paths: string[]): Items => paths.map((p) => [p, `path: ${p}\n${byPath.get(p)!.text.slice(0, config.fullChars)}`]);

  const pass1Job = scoreAll(scorer, task, docs.map((d) => [d.path, d.sketch]), config.batch, true);
  const bm25Ranked = rankBm25(task, new Map(docs.map((d) => [d.path, d.text])));
  const bm25Pool = bm25Ranked.slice(0, config.pool);
  const pass2a = config.overlapPasses ? scoreAll(scorer, task, full(bm25Pool), config.perCall, false) : null;
  // Keep a failing overlap from surfacing as an unhandled rejection while pass 1 is awaited.
  pass2a?.catch(() => {});
  const pass1 = await pass1Job;
  const pass1Done = performance.now();

  const bySketch = [...pass1.scores.keys()].sort((a, b) => pass1.scores.get(b)! - pass1.scores.get(a)! || compare(a, b));
  const inBm25Pool = new Set(bm25Pool);
  const extra = bySketch.slice(0, config.pool).filter((p) => !inBm25Pool.has(p));
  const pool = [...bm25Pool, ...extra];
  onProgress(`Scoring source from ${pool.length} shortlisted files`);
  let pass2: Scores;
  if (pass2a) {
    const pass2b: Scores = extra.length === 0 ? { scores: new Map(), failed: 0, batches: 0 } : await scoreAll(scorer, task, full(extra), config.perCall, false);
    const a = await pass2a;
    pass2 = {
      scores: new Map([...a.scores, ...pass2b.scores]),
      failed: a.failed + pass2b.failed,
      batches: a.batches + pass2b.batches,
      firstFailure: a.firstFailure ?? pass2b.firstFailure,
    };
    if (config.requireFullSourceScores && pass2.batches > 0 && pass2.failed === pass2.batches) throw pass2.firstFailure;
  } else {
    pass2 = await scoreAll(scorer, task, full(pool), config.perCall, config.requireFullSourceScores);
  }
  const relevance = pass2.scores;
  const pass2Done = performance.now();

  const bm25Pos = new Map(bm25Ranked.map((p, i) => [p, i]));
  const fused = new Map(pool.map((p) => [p, (relevance.get(p) ?? 0) + config.bm25Weight / (1 + (bm25Pos.get(p) ?? 999) / 10)]));
  const ranked = [...pool].sort((a, b) => fused.get(b)! - fused.get(a)! || compare(a, b));

  // Stage 3 reorders the top K with one comparison; if it fails, the order above stands.
  // Roles are a separate parallel call, so they can't shift the stage-3 order.
  const top = ranked.slice(0, config.stage3K);
  const choiceJob = scorer.choose && top.length >= 2
    ? optional(async () => {
      onProgress(`Comparing the top ${top.length}`);
      const result = await scorer.choose!(task, full(top));
      if (!samePaths(result, top) || ![...result.values()].every(isProbability)) {
        throw new Error("Chooser must return a probability for exactly the requested paths");
      }
      return result;
    })
    : null;
  const rolesJob = scorer.roles && top.length > 0
    ? optional(async () => {
      const result = await scorer.roles!(task, full(top));
      const valid = samePaths(result, top) && [...result.values()].every((probs) =>
        probs.size > 0 && [...probs].every(([role, p]) => ROLE_NAMES.includes(role as Role) && isProbability(p)));
      if (!valid) throw new Error("Role probabilities must be finite, within [0, 1], and use known roles");
      return result;
    })
    : null;
  const [choiceResult, roleResult] = await Promise.all([choiceJob, rolesJob]);
  const choice = choiceResult?.ok ? choiceResult.value : undefined;
  const roleOf = roleResult?.ok ? roleResult.value : new Map<string, Map<string, number>>();
  const done = performance.now();

  const scale = 1 + config.bm25Weight + (choice ? config.stage3Weight : 0);
  const files = pool.map((p): PackedFile => {
    const pos = bm25Pos.get(p);
    const probs = roleOf.get(p);
    const best = probs ? [...probs].reduce((x, y) => (y[1] > x[1] ? y : x)) : undefined;
    return {
      path: p,
      relevance: relevance.get(p) ?? 0,
      score: (fused.get(p)! + config.stage3Weight * (choice?.get(p) ?? 0)) / scale,
      bm25Rank: pos === undefined ? null : pos + 1,
      isTest: isTest(p),
      ...(best && best[1] >= ROLE_MIN && best[0] !== "unrelated" ? { role: best[0] as Role } : {}),
      ...(best ? { roleConfidence: best[1] } : {}),
    };
  }).sort((a, b) => b.score - a.score || compare(a.path, b.path)).slice(0, config.keep);

  return {
    task,
    files,
    candidates: docs.length,
    pass1Ms: Math.round(pass1Done - started),
    pass2Ms: Math.round(pass2Done - pass1Done),
    stage3Ms: Math.round(done - pass2Done),
    totalMs: Math.round(done - started),
    failedBatches: pass1.failed + pass2.failed + (choiceResult && !choiceResult.ok ? 1 : 0) + (roleResult && !roleResult.ok ? 1 : 0),
  };
}

/** Full-corpus lexical ranking with no model. The ordinal rank is the only score it exposes. */
export function packKeywords(task: string, docs: Map<string, string>, keep = 20): PackResult {
  if (!task.trim()) throw new RangeError("Task must not be blank");
  const started = performance.now();
  const ranked = rankBm25(task, docs);
  const elapsed = Math.round(performance.now() - started);
  return {
    task,
    files: ranked.slice(0, keep).map((path, i) => ({ path, relevance: 0, score: 0, bm25Rank: i + 1, isTest: isTest(path) })),
    candidates: docs.size,
    pass1Ms: elapsed,
    pass2Ms: 0,
    stage3Ms: 0,
    totalMs: elapsed,
    failedBatches: 0,
  };
}

function validate(task: string, docs: FileDoc[], c: PackConfig) {
  if (!task.trim()) throw new RangeError("Task must not be blank");
  if (docs.some((d) => !d.path.trim())) throw new RangeError("File paths must not be blank");
  if (new Set(docs.map((d) => d.path)).size !== docs.length) throw new RangeError("File paths must be unique");
  for (const key of ["batch", "pool", "perCall", "fullChars", "keep", "stage3K"] as const) {
    if (!Number.isInteger(c[key]) || c[key] <= 0) throw new RangeError(`${key} must be a positive integer`);
  }
  for (const key of ["bm25Weight", "stage3Weight"] as const) {
    if (!Number.isFinite(c[key]) || c[key] < 0) throw new RangeError(`${key} must be finite and non-negative`);
  }
}

/**
 * One failed batch costs its files a score of zero, not the whole pack. If every batch fails,
 * the model isn't answering at all, and quietly returning a keyword-only ranking would be a lie.
 */
async function scoreAll(scorer: Scorer, task: string, items: Items, groupSize: number, failIfAll: boolean): Promise<Scores> {
  const groups: Items[] = [];
  for (let i = 0; i < items.length; i += groupSize) groups.push(items.slice(i, i + groupSize));
  const parts = await Promise.all(groups.map(async (group) => {
    try {
      const response = await scorer.score(task, group);
      if (!samePaths(response, group.map(([p]) => p))) throw new Error("Scorer must return exactly the requested paths");
      if (![...response.values()].every(isProbability)) throw new Error("Scorer probabilities must be finite and within [0, 1]");
      return { ok: true as const, value: response };
    } catch (error) {
      if (error instanceof ScorerUnavailableError) throw error;
      return { ok: false as const, error };
    }
  }));
  const firstFailure = parts.find((p) => !p.ok);
  if (failIfAll && parts.length > 0 && parts.every((p) => !p.ok)) throw (firstFailure as { error: unknown }).error;
  const scores = new Map<string, number>();
  for (const part of parts) if (part.ok) for (const [k, v] of part.value) scores.set(k, v);
  for (const [p] of items) if (!scores.has(p)) scores.set(p, 0);
  return {
    scores,
    failed: parts.filter((p) => !p.ok).length,
    batches: parts.length,
    firstFailure: firstFailure && !firstFailure.ok ? firstFailure.error : undefined,
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function optional<T>(block: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await block() };
  } catch (error) {
    if (error instanceof ScorerUnavailableError) throw error;
    return { ok: false, error };
  }
}

function samePaths(result: Map<string, unknown>, paths: string[]): boolean {
  return result.size === paths.length && paths.every((p) => result.has(p));
}

function isProbability(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p <= 1;
}
