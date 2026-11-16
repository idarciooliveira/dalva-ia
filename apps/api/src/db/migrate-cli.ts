/** `bun run db:migrate`: apply pending migrations to DATABASE_URL. */
import { z } from "zod";

import { createLogger, errorFields } from "../log";
import { runMigrations } from "./migrate";

const env = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .safeParse({ DATABASE_URL: process.env.DATABASE_URL || undefined });
if (!env.success) {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "Invalid environment: DATABASE_URL must be a postgres:// URL" })}\n`);
  process.exit(1);
}

const url = env.data.DATABASE_URL;
const logger = createLogger({ level: "info", secrets: [decodeURIComponent(new URL(url).password)] });
const startedAt = Date.now();
try {
  await runMigrations(url);
  logger.info("migrations_applied", { ms: Date.now() - startedAt });
} catch (error) {
  logger.error("migrations_failed", errorFields(error));
  process.exit(1);
}
