import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Waits up to `timeoutSeconds` for running queries, then closes every connection. */
  close(timeoutSeconds?: number): Promise<void>;
}

export interface DatabaseOptions {
  url: string;
  /** Pool size. Default 10. */
  max?: number;
  /** Seconds to wait for a new connection before failing. Default 10. */
  connectTimeoutSeconds?: number;
}

/** postgres.js pool wrapped in Drizzle. Works under Bun and Node. */
export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const client = postgres(options.url, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    // Server notices (e.g. "relation already exists, skipping") are not errors; keep them out of stdout.
    onnotice: () => {},
    connection: { application_name: "dalva-api", TimeZone: "UTC" },
  });
  return {
    db: drizzle(client, { schema }),
    close: (timeoutSeconds = 5) => client.end({ timeout: timeoutSeconds }),
  };
}
