import { fail } from "@mpf/finance-contract";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Database } from "./db/client";
import { errorFields, type Logger } from "./log";

export interface AppOptions {
  db: Database;
  logger: Logger;
  /** How long `/health` waits for `select 1`. Default 2000 ms. */
  healthTimeoutMs?: number;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const healthTimeoutMs = options.healthTimeoutMs ?? 2_000;

  // Liveness and readiness in one: 503 while the database can't answer.
  app.get("/health", async (c) => {
    const database = await pingDatabase(options.db, healthTimeoutMs);
    return c.json({ ok: database === "up", database }, database === "up" ? 200 : 503);
  });

  app.notFound((c) => c.json(fail("not_found", "Not found"), 404));
  app.onError((error, c) => {
    options.logger.error("request_failed", { method: c.req.method, path: c.req.path, ...errorFields(error) });
    return c.json(fail("internal", "Internal error"), 500);
  });
  return app;
}

async function pingDatabase(db: Database, timeoutMs: number): Promise<"up" | "down"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"down">((resolve) => {
    timer = setTimeout(() => resolve("down"), timeoutMs);
  });
  try {
    return await Promise.race([
      db.execute(sql`select 1`).then(
        () => "up" as const,
        () => "down" as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
