import { createTelegramAdapter } from "./channels/telegram/adapter";
import { ConfigError, loadConfig } from "./config";
import { createFinanceClients } from "./core/finance";
import { createHandler } from "./core/handler";
import { createFinanceProbe } from "./core/health";
import { createPipeline } from "./core/pipeline";
import { createApp } from "./http";
import { createLogger, errorFields } from "./log";

/** Below Docker's default 10s stop timeout (SIGKILL after). */
const SHUTDOWN_DRAIN_MS = 8_000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

async function main() {
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

  const logger = createLogger({
    level: config.LOG_LEVEL,
    secrets: [config.TELEGRAM_BOT_TOKEN, config.FINANCE_API_SERVICE_KEY, config.TELEGRAM_WEBHOOK_SECRET ?? ""],
  });

  const adapter = createTelegramAdapter({
    token: config.TELEGRAM_BOT_TOKEN,
    botUsername: config.TELEGRAM_BOT_USERNAME,
    mode: config.TELEGRAM_MODE,
    webhookSecret: config.TELEGRAM_WEBHOOK_SECRET,
    logger,
  });
  const clients = createFinanceClients({ baseUrl: config.FINANCE_API_URL, serviceKey: config.FINANCE_API_SERVICE_KEY });
  const { handle, onFailure, accept } = createHandler({
    adapter,
    clients,
    logger,
    sessionIdleMinutes: config.SESSION_IDLE_MINUTES,
  });
  const pipeline = createPipeline({
    adapter,
    service: clients.service,
    handle,
    onFailure,
    accept,
    logger,
    recoveryMaxAgeSeconds: config.RECOVERY_MAX_AGE_SECONDS,
  });

  /** Intake opens only after boot recovery finished; the webhook answers 503 until then. */
  let accepting = false;
  let stopping = false;
  let server: { stop(closeActiveConnections?: boolean): Promise<void> } | undefined;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown_started", { signal });
    // Intake first, then drain everything that was accepted.
    accepting = false;
    await adapter.stop();
    const drained = await pipeline.shutdown(SHUTDOWN_DRAIN_MS);
    await server?.stop();
    logger.info("shutdown_complete", { drained });
    process.exit(drained ? 0 : 1);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const app = createApp({
    adapter,
    pipeline,
    mode: config.TELEGRAM_MODE,
    probeFinance: createFinanceProbe({ baseUrl: config.FINANCE_API_URL }),
    isAccepting: () => accepting,
  });
  // Up for /health during recovery; the webhook route refuses until `accepting`.
  server = Bun.serve({ port: config.PORT, fetch: app.fetch, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  logger.info("server_started", { port: config.PORT, mode: config.TELEGRAM_MODE });

  // Events a dead process left unfinished run to completion, in arrival order, before anything new.
  // Without the backend nothing can be claimed either, so a failed recovery is fatal: the orchestrator restarts us.
  await pipeline.recover();
  if (stopping) return;

  accepting = true;
  await adapter.start(pipeline.deliver);
  logger.info("intake_open");
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "boot_failed", ...errorFields(error) })}\n`);
  process.exit(1);
});
