import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { createUserTokens } from "./auth/tokens";
import { ConfigError, configSecrets, loadConfig } from "./config";
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

  const logger = createLogger({ level: config.LOG_LEVEL, secrets: configSecrets(config) });
  // Connections open lazily; /health reports whether the database answers.
  const database = createDatabase({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
  const auth = createAuth({
    db: database.db,
    logger,
    publicUrl: config.PUBLIC_URL,
    secret: config.BETTER_AUTH_SECRET,
    clientIpHeader: config.CLIENT_IP_HEADER,
  });
  if (!config.CLIENT_IP_HEADER) logger.warn("auth_rate_limit_off", { reason: "CLIENT_IP_HEADER unset" });
  const tokens = createUserTokens(config.FINANCE_API_TOKEN_SECRET);
  const app = createApp({ db: database.db, logger, auth, tokens, publicUrl: config.PUBLIC_URL });
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  logger.info("server_started", { port: config.PORT, publicUrl: config.PUBLIC_URL });

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
