import { drizzle } from "drizzle-orm/postgres-js";

import type { Database } from "../db/client";
import * as schema from "../db/schema";

/**
 * Run `fn` on one reserved connection while that connection holds the
 * session-level Postgres advisory lock `name`, or return `{ ran: false }` at
 * once when another connection (another API instance) holds it. `fn` gets a
 * database bound to that connection: each statement autocommits, so a job's
 * batches stay small, and the job never needs a second pool connection (a
 * one-connection pool can't deadlock on it).
 *
 * If the unlock fails, the lock is dropped with `pg_advisory_unlock_all()`;
 * when even that fails the connection is broken, and Postgres released the
 * lock with the session. Either way no pooled connection keeps it.
 */
export async function withAdvisoryLock<T>(
  db: Database,
  name: string,
  fn: (lockedDb: Database) => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${name}, 0)) as locked`;
    if (!row?.locked) return { ran: false };
    try {
      // A reserved connection has no `options` of its own; it parses with the pool's, which Drizzle already set up.
      const lockedDb = drizzle(Object.assign(connection, { options: db.$client.options }), { schema });
      return { ran: true, value: await fn(lockedDb as unknown as Database) };
    } finally {
      await connection`select pg_advisory_unlock(hashtextextended(${name}, 0))`.catch(() =>
        connection`select pg_advisory_unlock_all()`.catch(() => undefined),
      );
    }
  } finally {
    connection.release();
  }
}
