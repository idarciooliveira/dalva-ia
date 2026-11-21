import type { Database } from "../db/client";

/**
 * Run `fn` while holding the Postgres advisory lock `name`, or return
 * `{ ran: false }` at once when another connection (another API instance)
 * holds it. The lock is transaction-level, taken in a transaction kept open on
 * its own connection for the whole run (it touches no table, so it holds no
 * snapshot back): `fn` may commit many transactions on the pool meanwhile, and
 * the lock goes when that transaction ends, whether `fn` returns, throws or
 * the connection dies. Nothing can leave it held on a pooled connection.
 */
export async function withAdvisoryLock<T>(db: Database, name: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  return await db.$client.begin(async (lockTx) => {
    const [row] = await lockTx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) as locked`;
    if (!row?.locked) return { ran: false as const };
    return { ran: true as const, value: await fn() };
  });
}
