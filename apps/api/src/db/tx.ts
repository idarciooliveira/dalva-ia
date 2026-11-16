import type { Database } from "./client";

/** The transaction handle passed to `withTx` callbacks. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface TxOptions {
  /** Total tries, including the first. Default 5. */
  maxAttempts?: number;
  /** Called before each retry, e.g. to log it. */
  onRetry?: (info: { attempt: number; code: string }) => void;
}

/**
 * SQLSTATEs worth running the whole transaction again for:
 * - 40001 serialization_failure: SERIALIZABLE found a conflicting concurrent
 *   transaction (also raised at COMMIT).
 * - 40P01 deadlock_detected: still possible under SERIALIZABLE when two
 *   transactions update the same rows in opposite order (a transfer A→B next
 *   to B→A). Postgres aborts one; a rerun succeeds.
 * Unique violations (23505) are not retried: they are real conflicts the
 * caller maps to an API error.
 */
const RETRYABLE = new Set(["40001", "40P01"]);
const DEFAULT_MAX_ATTEMPTS = 5;

/** SQLSTATE of a Postgres error, also when Drizzle wraps it (`cause`). */
export function sqlState(error: unknown): string | undefined {
  for (let current = error, depth = 0; typeof current === "object" && current !== null && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isRetryableTxError(error: unknown): boolean {
  const code = sqlState(error);
  return code !== undefined && RETRYABLE.has(code);
}

/**
 * Run `fn` in one SERIALIZABLE transaction; on a serialization failure or
 * deadlock, roll back and run it again, up to `maxAttempts` times, then
 * rethrow. This gives every write the isolation the Convex mutations had.
 *
 * `fn` may run more than once: keep side effects outside the database
 * (HTTP calls, timers, logs that claim success) out of it, and don't let it
 * depend on state that a failed attempt mutated in memory.
 */
export async function withTx<T>(db: Database, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(fn, { isolationLevel: "serializable" });
    } catch (error) {
      const code = sqlState(error);
      if (attempt >= maxAttempts || code === undefined || !RETRYABLE.has(code)) throw error;
      options.onRetry?.({ attempt, code });
      // Jittered backoff so the transactions that collided don't collide again in lockstep.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * 2 ** attempt));
    }
  }
}
