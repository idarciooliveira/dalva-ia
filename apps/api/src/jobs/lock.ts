import type { Database } from "../db/client";

/**
 * Run `fn` while holding the session-level Postgres advisory lock `name`, or
 * return `{ ran: false }` at once when another connection (another API
 * instance) holds it. The lock lives on one reserved connection for the whole
 * run, so `fn` may commit many transactions on the pool meanwhile; if the
 * process dies, the connection closes and Postgres releases the lock.
 */
export async function withAdvisoryLock<T>(db: Database, name: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${name}, 0)) as locked`;
    if (!row?.locked) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await connection`select pg_advisory_unlock(hashtextextended(${name}, 0))`;
    }
  } finally {
    connection.release();
  }
}
