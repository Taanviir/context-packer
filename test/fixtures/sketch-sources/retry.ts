import { setTimeout as sleep } from "node:timers/promises";

/** Options for retrying a flaky call. */
export interface RetryOptions {
  attempts: number;
  /** Base delay in milliseconds. */
  baseMs: number;
}

/**
 * Retries with exponential backoff.
 */
export class Retrier {
    private readonly log: string[] = [];

    constructor(private readonly options: RetryOptions) {}

    /** Runs fn until it succeeds or attempts run out. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        for (let i = 0; ; i++) {
            try {
                return await fn();
            } catch (error) {
                if (i + 1 >= this.options.attempts) throw error;
                await sleep(this.options.baseMs * 2 ** i);
            }
        }
    }
}

export const DEFAULT_OPTIONS: RetryOptions = { attempts: 3, baseMs: 100 };
export function withRetry<T>(fn: () => Promise<T>) { return new Retrier(DEFAULT_OPTIONS).run(fn); }
var legacyCounter = 0
