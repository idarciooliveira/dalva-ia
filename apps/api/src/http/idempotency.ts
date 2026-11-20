/**
 * `Idempotency-Key` on finance writes, stored in the write's own transaction:
 * - unknown key: run the write, store `(user, key) -> hash + response`
 * - same key, same request: return the stored response, nothing re-executes
 * - same key, different request (body or operation): `conflict`
 * - a key older than the TTL counts as unused, purged or not
 * A failed write rolls back with its record, so the client can retry with the
 * same key. Two concurrent requests with one key serialize: the second waits
 * on the first's claim, then gets a serialization failure, `withTx` reruns
 * it, and it replays the first.
 */
import { createHash } from "node:crypto";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { conflict } from "../domain/errors";
import type { Database } from "../db/client";
import { apiIdempotencyKeys } from "../db/schema";
import type { Tx } from "../db/tx";

/** Keys are replayable for this long, then purged. */
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PURGE_BATCH = 500;

/** JSON with sorted keys, so the hash ignores key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the operation name and its parsed input. */
export function requestHash(operation: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
}

export interface IdempotencyRecord {
  userId: string;
  key: string;
  hash: string;
}

/**
 * Claim the key for this write, or return what it already holds.
 *
 * The hot path is a plain `INSERT ... ON CONFLICT DO NOTHING`: its conflict
 * check reads no rows under SERIALIZABLE, so writes of different users don't
 * collide on the index pages they share (UUIDv7 ids cluster), which a
 * `SELECT` first made them do. The row is read only when the key exists.
 * A conflicting row committed after this transaction's snapshot makes
 * Postgres raise a serialization failure, and `withTx` reruns the whole write.
 */
export async function claimKey(
  tx: Tx,
  record: IdempotencyRecord,
  now = Date.now(),
): Promise<{ claimed: true } | { claimed: false; data: unknown }> {
  for (let tries = 0; tries < 2; tries++) {
    const [claimed] = await tx
      .insert(apiIdempotencyKeys)
      // The app's clock, like the expiry checks: app and database clocks may differ.
      .values({ userId: record.userId, key: record.key, requestHash: record.hash, response: null, createdAt: new Date(now) })
      .onConflictDoNothing({ target: [apiIdempotencyKeys.userId, apiIdempotencyKeys.key] })
      .returning({ id: apiIdempotencyKeys.id });
    if (claimed) return { claimed: true };

    const [existing] = await tx
      .select()
      .from(apiIdempotencyKeys)
      .where(and(eq(apiIdempotencyKeys.userId, record.userId), eq(apiIdempotencyKeys.key, record.key)))
      .limit(1);
    if (!existing) break;
    if (existing.createdAt.getTime() < now - IDEMPOTENCY_TTL_MS) {
      // Expired but not purged yet: behave exactly as after the purge.
      await tx.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.id, existing.id));
      continue;
    }
    if (existing.requestHash !== record.hash) {
      throw conflict("Idempotency-Key was already used with a different request");
    }
    return { claimed: false, data: existing.response };
  }
  // Only reachable if the row vanished between the insert and the read (a concurrent purge).
  throw new Error("idempotency key could not be claimed");
}

/**
 * Store the write's response on the claimed key and return it as stored. Send
 * that one: `jsonb` reorders object keys, so the first answer and its replays
 * are then byte-identical. An upsert again, to keep reads off the hot path.
 */
export async function storeResponse(tx: Tx, record: IdempotencyRecord, data: unknown): Promise<unknown> {
  const [stored] = await tx
    .insert(apiIdempotencyKeys)
    .values({ userId: record.userId, key: record.key, requestHash: record.hash, response: data })
    .onConflictDoUpdate({ target: [apiIdempotencyKeys.userId, apiIdempotencyKeys.key], set: { response: sql`excluded.response` } })
    .returning({ response: apiIdempotencyKeys.response });
  return stored!.response;
}

/** Delete one batch of keys older than the TTL. Returns how many; call again while it returns a full batch. */
export async function purgeExpiredIdempotencyKeys(db: Database, options: { now?: number; batch?: number } = {}): Promise<number> {
  const cutoff = new Date((options.now ?? Date.now()) - IDEMPOTENCY_TTL_MS);
  const batch = options.batch ?? PURGE_BATCH;
  // One statement, outside SERIALIZABLE: a key re-claimed meanwhile is a new row, so nothing here needs isolation,
  // and a range read over `created_at` would only add conflicts with the writers.
  const expired = db
    .select({ id: apiIdempotencyKeys.id })
    .from(apiIdempotencyKeys)
    .where(lt(apiIdempotencyKeys.createdAt, cutoff))
    .limit(batch);
  const deleted = await db
    .delete(apiIdempotencyKeys)
    .where(inArray(apiIdempotencyKeys.id, expired))
    .returning({ id: apiIdempotencyKeys.id });
  return deleted.length;
}
