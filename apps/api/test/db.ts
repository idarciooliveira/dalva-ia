import { sql } from "drizzle-orm";

import { createDatabase, type Database, type DatabaseHandle } from "../src/db/client";
import { adminClient, databaseUrl, templateName, workerDatabaseName } from "./databases";

let handle: DatabaseHandle | undefined;
let url: string | undefined;
let truncateStatement: string | undefined;

/** The current worker's database, connected by test/setup.ts. */
export function testDb(): Database {
  if (!handle) throw new Error("test database not connected (is test/setup.ts in setupFiles?)");
  return handle.db;
}

/** Connection URL of the worker's database, for tests that need their own pool. */
export function testDatabaseUrl(): string {
  if (!url) throw new Error("test database not connected (is test/setup.ts in setupFiles?)");
  return url;
}

export async function connectTestDatabase(serverUrl: string, runId: string): Promise<void> {
  // Stable per worker for the whole run; test files of one worker run one at a time.
  const workerId = process.env.VITEST_POOL_ID ?? "1";
  const name = workerDatabaseName(runId, workerId);
  const admin = adminClient(serverUrl);
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${name}`;
    if (!exists) await admin.unsafe(`create database "${name}" template "${templateName(runId)}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  url = databaseUrl(serverUrl, name);
  handle = createDatabase({ url, max: 5, connectTimeoutSeconds: 5 });

  // Every test truncates all tables: make sure that is this worker's throwaway database and nothing else.
  const [current] = await handle.db.execute<{ name: string }>(sql`select current_database() as name`);
  if (current?.name !== name) {
    await handle.close();
    handle = undefined;
    throw new Error(`refusing to run tests: connected to "${current?.name}", expected "${name}"`);
  }

  const tables = await handle.db.execute<{ name: string }>(sql`
    select quote_ident(tablename) as name from pg_tables where schemaname = 'public' order by tablename
  `);
  truncateStatement = tables.length ? `truncate ${tables.map((t) => t.name).join(", ")} restart identity cascade` : "";
}

export async function truncateAll(): Promise<void> {
  if (!handle || truncateStatement === undefined) throw new Error("test database not connected");
  if (truncateStatement) await handle.db.execute(sql.raw(truncateStatement));
}

export async function disconnectTestDatabase(): Promise<void> {
  await handle?.close();
  handle = undefined;
}
