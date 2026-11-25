import { createTelegramChannel } from "./channels/telegram/runtime";
import { ConfigError, loadConfig } from "./config";
import { createAgent } from "./core/agent";
import { createFinanceClients } from "./core/finance";
import type { ChatOptions } from "./core/handler";
import { createHandler } from "./core/handler";
import { createFinanceProbe } from "./core/health";
import { createPipeline } from "./core/pipeline";
import { createRateLimiter } from "./core/rate-limit";
import { createConfigSource, type AiConfig } from "./core/remote-config";
import { createApp } from "./http";
import { getModel } from "./llm/model";
import { createLogger, errorFields } from "./log";

/** Below Docker's default 10s stop timeout (SIGKILL after). */
const SHUTDOWN_DRAIN_MS = 8_000;
/**
 * Agent turns still running this long into the drain are aborted, so they
 * fail (the user gets the apology) inside the drain instead of being killed
 * and replayed, paid for twice, by the next boot's recovery.
 */
const SHUTDOWN_TURN_GRACE_MS = 5_000;
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

  // The runtime config's secrets join the list as it loads.
  const secrets = new Set([config.FINANCE_API_SERVICE_KEY]);
  const logger = createLogger({ level: config.LOG_LEVEL, secrets: () => secrets });

  const clients = createFinanceClients({ baseUrl: config.FINANCE_API_URL, serviceKey: config.FINANCE_API_SERVICE_KEY });
  // Bot and AI settings come from the API (Settings → Assistant in the web app), not the env.
  const remote = createConfigSource({
    load: () => clients.service.instance.agentConfig.query(),
    logger,
    onSecrets: (values) => values.forEach((value) => secrets.add(value)),
  });
  const channel = createTelegramChannel({ logger, refresh: () => remote.refresh() });
  const stopTurns = new AbortController();

  const limiter = createRateLimiter({ limit: config.AGENT_RATE_LIMIT_TURNS, windowMs: config.AGENT_RATE_LIMIT_WINDOW_MINUTES * 60_000 });
  let chat: ChatOptions | undefined;
  const chatFor = (ai: AiConfig | null): ChatOptions | undefined =>
    ai
      ? {
          limiter,
          agent: createAgent({
            model: getModel({ provider: ai.provider, modelId: ai.model, apiKey: ai.apiKey }),
            maxSteps: config.AGENT_MAX_STEPS,
            maxOutputTokens: config.AGENT_MAX_OUTPUT_TOKENS,
            turnTimeoutMs: config.AGENT_TURN_TIMEOUT_SECONDS * 1000,
            timezone: config.DEFAULT_TIMEZONE,
            logger,
            stopSignal: stopTurns.signal,
          }),
        }
      : undefined;

  const { handle, onFailure, accept } = createHandler({
    adapter: channel,
    clients,
    logger,
    sessionIdleMinutes: config.SESSION_IDLE_MINUTES,
    chat: () => chat,
  });
  const pipeline = createPipeline({
    adapter: channel,
    service: clients.service,
    handle,
    onFailure,
    accept,
    logger,
    recoveryMaxAgeSeconds: config.RECOVERY_MAX_AGE_SECONDS,
  });

  /** Intake opens once a bot is configured and boot recovery finished; the webhook answers 503 until then. */
  let accepting = false;
  let stopping = false;
  let intake: Promise<void> | null = null;
  let server: { stop(closeActiveConnections?: boolean): Promise<void> } | undefined;

  // Events a dead process left unfinished run to completion, in arrival order, before anything new.
  // Without the backend nothing can be claimed either, so a failed recovery is fatal: the orchestrator restarts us.
  const openIntake = () => {
    intake ??= (async () => {
      try {
        await pipeline.recover();
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ level: "error", msg: "recovery_failed", ...errorFields(error) })}\n`);
        process.exit(1);
      }
      if (stopping) return;
      accepting = true;
      logger.info("intake_open");
      await startChannel();
    })();
  };
  /** A bot Telegram refuses (polling: revoked token) is not fatal: logged, and tried again on the next config load. */
  const startChannel = async () => {
    try {
      await channel.start(pipeline.deliver);
    } catch (error) {
      logger.warn("telegram_start_failed", errorFields(error));
      remote.invalidate();
    }
  };

  remote.onChange(async (next) => {
    chat = chatFor(next.ai);
    if (accepting) {
      // A refused start leaves no bot; `configure` starts the new one (it knows `deliver` already).
      await channel.configure(next.telegram).catch((error: unknown) => {
        logger.warn("telegram_start_failed", errorFields(error));
        remote.invalidate();
      });
      return;
    }
    await channel.configure(next.telegram);
    if (next.telegram) openIntake();
  });

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown_started", { signal });
    // Intake first, then drain everything that was accepted.
    accepting = false;
    remote.stop();
    const stopTimer = setTimeout(() => stopTurns.abort(new Error("shutdown")), SHUTDOWN_TURN_GRACE_MS);
    await channel.stop();
    const drained = await pipeline.shutdown(SHUTDOWN_DRAIN_MS);
    clearTimeout(stopTimer);
    await server?.stop();
    logger.info("shutdown_complete", { drained });
    process.exit(drained ? 0 : 1);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const app = createApp({
    adapter: channel,
    pipeline,
    mode: () => channel.delivery ?? "unconfigured",
    chat: () => chat !== undefined,
    probeFinance: createFinanceProbe({ baseUrl: config.FINANCE_API_URL }),
    isAccepting: () => accepting,
    onClosedWebhook: () => void remote.refresh(),
  });
  // Up for /health from the start, configured or not; the webhook route refuses until `accepting`.
  server = Bun.serve({ port: config.PORT, fetch: app.fetch, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  logger.info("server_started", { port: config.PORT });

  await remote.refresh();
  remote.start();
  if (!remote.current?.telegram) logger.info("waiting_for_settings", { reason: "no Telegram bot configured yet (web app: Settings → Assistant setup)" });
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "boot_failed", ...errorFields(error) })}\n`);
  process.exit(1);
});
