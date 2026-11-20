import { createApp } from "./app";
import { ConfigError, databasePassword, loadConfig } from "./config";
import { createDatabase } from "./db/client";
import { createLogger, errorFields } from "./log";

/** Below Docker's default 10s stop timeout (SIGKILL after). */
const SHUTDOWN_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: error.message })}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.LOG_LEVEL, secrets: [databasePassword(config)] });
  // Connections open lazily; /health reports whether the database answers.
  const database = createDatabase({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  const app = createApp({ db: database.db, logger });
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  logger.info("server_started", { port: config.PORT });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown_started", { signal });
    const deadline = setTimeout(() => {
      logger.error("shutdown_timeout");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      // Stop accepting, let in-flight requests finish, then close the pool.
      await server.stop();
      await database.close(5);
      clearTimeout(deadline);
      logger.info("shutdown_complete");
      process.exit(0);
    } catch (error) {
      logger.error("shutdown_failed", errorFields(error));
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "boot_failed", ...errorFields(error) })}\n`);
  process.exit(1);
}
