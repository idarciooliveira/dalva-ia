import { createTelegramAdapter } from "./channels/telegram/adapter";
import { ConfigError, loadConfig } from "./config";
import { createFinanceClients } from "./core/finance";
import { createHandler } from "./core/handler";
import { createFinanceProbe } from "./core/health";
import { createPipeline } from "./core/pipeline";
import { createApp } from "./http";
import { createLogger, errorFields } from "./log";

const SHUTDOWN_DRAIN_MS = 20_000;

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
  const { handle, onFailure } = createHandler({
    adapter,
    clients,
    logger,
    sessionIdleMinutes: config.SESSION_IDLE_MINUTES,
  });
  const pipeline = createPipeline({ adapter, service: clients.service, handle, onFailure, logger });

  let ready = false;
  const app = createApp({
    adapter,
    pipeline,
    mode: config.TELEGRAM_MODE,
    probeFinance: createFinanceProbe({ baseUrl: config.FINANCE_API_URL }),
    isReady: () => ready,
  });
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
  logger.info("server_started", { port: config.PORT, mode: config.TELEGRAM_MODE });

  try {
    await pipeline.recover();
  } catch (error) {
    // The backend may be down at boot; unfinished events stay recoverable for the next start.
    logger.error("recover_failed", errorFields(error));
  }
  ready = true;
  await adapter.start(pipeline.deliver, pipeline.waitForCapacity);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown_started", { signal });
    ready = false;
    await adapter.stop();
    const drained = await pipeline.shutdown(SHUTDOWN_DRAIN_MS);
    await server.stop();
    logger.info("shutdown_complete", { drained });
    process.exit(drained ? 0 : 1);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "boot_failed", ...errorFields(error) })}\n`);
  process.exit(1);
});
