import type { Items, Scorer } from "./packer.js";

/** Where Jev is served from. Both take the same state and questions; they differ in envelope. */
export const JEV_BACKENDS = {
  /** TypeSafe's own API, as typesafe-sdk 0.7.1 calls it. */
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
  /** Vercel AI Gateway's evaluation-model route. Yes/no questions are `boolean` there. */
  gateway: { endpoint: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", model: "typesafe-ai/jev" },
} as const;
export type JevBackend = keyof typeof JEV_BACKENDS;

/** USD per million input tokens. */
export const JEV_INPUT_PRICE = 0.042;

export interface CallStat {
  ms: number;
  inputTokens: number;
  questions: number;
  error: string | null;
  usageKnown: boolean;
}

export class JevError extends Error {
  override name = "JevError";
  constructor(readonly status: number | null, message: string) {
    super(message);
  }
}

type Question = { type: "noul"; instructions: string } | { type: "choice"; instructions: string; criteria: Record<string, string> };

export interface JevResponse {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  inputTokens: number;
  usageKnown: boolean;
}

export interface JevClientOptions {
  apiKey: string;
  backend?: JevBackend;
  model?: string;
  endpoint?: string;
  /** One pack is ~55 calls. 48 in flight stays far inside TypeSafe's 1,200 a minute and makes pass 1 one wave. */
  concurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

const RETRY_STATUSES = new Set([408, 429]);
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const BACKOFF_JITTER = 0.25;

/** Mirrors the official SDKs' wire format and retry policy: 408, 429 and 5xx; exponential backoff with jitter; `retry-after`. */
export class JevClient {
  readonly backend: JevBackend;
  readonly model: string;
  /** Every dispatched HTTP attempt, including retries and failures. */
  readonly calls: CallStat[] = [];
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetch: typeof fetch;
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(private readonly options: JevClientOptions) {
    this.backend = options.backend ?? "typesafe";
    this.model = options.model ?? JEV_BACKENDS[this.backend].model;
    this.endpoint = options.endpoint ?? JEV_BACKENDS[this.backend].endpoint;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.limit = semaphore(options.concurrency ?? (this.backend === "gateway" ? 2 : 48));
  }

  get inputTokens(): number {
    return this.calls.reduce((sum, c) => sum + c.inputTokens, 0);
  }

  /** Questions are written in TypeSafe's vocabulary (`noul`); the gateway's is translated here. */
  systemOne(state: Record<string, string>, questions: Record<string, Question>): Promise<JevResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    let body: unknown;
    if (this.backend === "typesafe") {
      body = { model: this.model, state, questions };
    } else {
      Object.assign(headers, {
        "ai-gateway-protocol-version": "0.0.1",
        "ai-gateway-auth-method": "api-key",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": this.model,
      });
      const translated = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === "noul" ? { ...q, type: "boolean" } : q]));
      body = { state, questions: translated };
    }
    const count = Object.keys(questions).length;
    return this.limit(() => this.send(headers, JSON.stringify(body), count));
  }

  private async send(headers: Record<string, string>, body: string, questions: number): Promise<JevResponse> {
    let wait = 0;
    let lastStatus: number | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(wait);
      const started = performance.now();
      let response: Response;
      let text: string;
      try {
        response = await this.fetch(this.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        text = await response.text();
      } catch (error) {
        lastStatus = null;
        lastError = `${(error as Error).name}: ${(error as Error).message}`;
        this.record(started, 0, questions, lastError, false);
        wait = backoff(attempt + 1);
        continue;
      }
      if (response.status === 200) {
        let parsed: JevResponse;
        try {
          parsed = parseJevResponse(text);
        } catch (error) {
          const tokens = inputTokensIn(text);
          this.record(started, tokens ?? 0, questions, "Jev returned an invalid HTTP 200 response", tokens !== null);
          throw error;
        }
        this.record(started, parsed.inputTokens, questions, null, parsed.usageKnown);
        return { ...parsed, model: parsed.model || this.model };
      }
      lastStatus = response.status;
      lastError = `${describe(response.status)} (HTTP ${response.status}): ${text.slice(0, 200)}`;
      const tokens = inputTokensIn(text);
      this.record(started, tokens ?? 0, questions, lastError, tokens !== null);
      if (!RETRY_STATUSES.has(response.status) && response.status < 500) break;
      wait = retryAfterMs(response.headers) ?? backoff(attempt + 1);
    }
    throw new JevError(lastStatus, lastError);
  }

  private record(started: number, inputTokens: number, questions: number, error: string | null, usageKnown: boolean) {
    this.calls.push({ ms: Math.round(performance.now() - started), inputTokens, questions, error, usageKnown });
  }
}

export function parseJevResponse(body: string): JevResponse {
  const root = JSON.parse(body) as Record<string, unknown>;
  if (typeof root !== "object" || root === null) throw new Error("Jev response is not an object");
  const tokens = knownInputTokens(root);
  return {
    model: typeof root.model === "string" ? root.model : "",
    answers: (root.answers ?? {}) as JevResponse["answers"],
    inputTokens: tokens ?? 0,
    usageKnown: tokens !== null,
  };
}

/** P(statement is true) for a yes/no question: `noul` on TypeSafe, `probability` on the gateway. */
export function noul(response: JevResponse, key: string): number | null {
  const answer = response.answers[key];
  const value = answer?.noul ?? answer?.probability;
  return typeof value === "number" ? value : null;
}

export function probabilities(response: JevResponse, key: string): Map<string, number> {
  const probs = response.answers[key]?.probabilities;
  if (typeof probs !== "object" || probs === null) return new Map();
  return new Map(Object.entries(probs as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number"));
}

/**
 * One Jev call for a batch of files. Each file gets its own key in the state, and its own
 * question naming that key, which is how a hundred files share one request.
 */
export class JevScorer implements Scorer {
  constructor(private readonly client: JevClient, private readonly options: { compareTop?: boolean; assignRoles?: boolean } = {}) {
    if (options.compareTop === false) this.choose = undefined;
    if (options.assignRoles === false) this.roles = undefined;
  }

  async score(task: string, items: Items): Promise<Map<string, number>> {
    const { keys, state } = frame(task, items);
    const questions = Object.fromEntries([...keys.keys()].map((k) => [k, { type: "noul" as const, instructions: relevanceQuestion(k) }]));
    const response = await this.client.systemOne(state, questions);
    return new Map([...keys].map(([key, path]) => {
      const p = noul(response, key);
      if (p === null || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`Jev returned no valid relevance probability for ${key}`);
      return [path, p];
    }));
  }

  choose? = async (task: string, items: Items): Promise<Map<string, number>> => {
    const { keys, state } = frame(task, items);
    const criteria = Object.fromEntries([...keys].map(([key, path]) => [key, `the file in \`${key}\` (${path})`]));
    const response = await this.client.systemOne(state, { pick: { type: "choice", instructions: CHOICE_QUESTION, criteria } });
    const probs = probabilities(response, "pick");
    if (probs.size !== keys.size || ![...keys.keys()].every((k) => probs.has(k))) {
      throw new Error("Jev returned invalid or incomplete comparative probabilities");
    }
    return new Map([...keys].map(([key, path]) => [path, probs.get(key)!]));
  };

  roles? = async (task: string, items: Items): Promise<Map<string, Map<string, number>>> => {
    const { keys, state } = frame(task, items);
    const questions = Object.fromEntries([...keys.keys()].map((key) => [`role_${key}`, {
      type: "choice" as const,
      instructions: `What part does the file in \`${key}\` play in the change described in \`task\`?`,
      criteria: ROLES,
    }]));
    const response = await this.client.systemOne(state, questions);
    return new Map([...keys].map(([key, path]) => [path, probabilities(response, `role_${key}`)]));
  };
}

export const ROLES: Record<string, string> = {
  edit: "Implementing the change requires editing this file.",
  test: "This file tests the code being changed and would need updating.",
  example: "This file shows an existing pattern the change should follow, but is not edited.",
  dependency: "The change uses an API declared in this file, but the file is not edited.",
  unrelated: "This file has nothing to do with the change.",
};

/** Stage 3's question. Chosen on dev (recall@5 0.536 to 0.583), measured once on test (0.539 to 0.572). */
export const CHOICE_QUESTION = "Which file must be edited to implement the change described in `task`?";

/** The broader wording won in the spike: 0.66 vs 0.59 recall@10 for "requires editing". */
export function relevanceQuestion(key: string): string {
  return `Implementing the change described in \`task\` requires reading or editing the file in \`${key}\`.`;
}

function frame(task: string, items: Items) {
  const keys = new Map(items.map(([path], i) => [`f${String(i).padStart(3, "0")}`, path]));
  const state: Record<string, string> = { task };
  items.forEach(([, text], i) => { state[`f${String(i).padStart(3, "0")}`] = text; });
  return { keys, state };
}

function knownInputTokens(root: Record<string, unknown>): number | null {
  const usage = root.usage as Record<string, unknown> | undefined;
  const value = usage?.input_tokens ?? usage?.inputTokens;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function inputTokensIn(body: string): number | null {
  try {
    return knownInputTokens(JSON.parse(body));
  } catch {
    return null;
  }
}

function describe(status: number): string {
  if (status === 401 || status === 403) return "Jev rejected the API key";
  if (status === 402) return "No credits left on this Jev account";
  if (status === 413) return "Request too large for Jev";
  if (status === 429) return "Jev rate limit hit";
  if (status >= 500 && status <= 599) return "Jev is having trouble";
  return "Jev request failed";
}

function backoff(attempt: number): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** Math.min(attempt - 1, 10));
  return exponential * (1 - Math.random() * BACKOFF_JITTER);
}

/** Honours the server's retry-after, capped so one long value can't stall a pack that holds a permit. */
function retryAfterMs(headers: Headers): number | null {
  const ms = Number(headers.get("retry-after-ms") ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, BACKOFF_MAX_MS);
  const seconds = Number(headers.get("retry-after") ?? NaN);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, BACKOFF_MAX_MS);
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function semaphore(permits: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A released permit passes straight to the next waiter, so a newcomer can't slip in between.
    if (active >= permits) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
