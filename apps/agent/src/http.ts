import { Hono } from "hono";

import type { ChannelAdapter } from "./channels/channel";
import type { Reachability } from "./core/health";
import type { Pipeline } from "./core/pipeline";

export interface AppOptions {
  adapter: ChannelAdapter;
  pipeline: Pipeline;
  /** How Telegram reaches the agent right now (it follows the instance settings). */
  mode: () => "webhook" | "polling" | "unconfigured";
  /** Whether an AI provider is configured (chat), for /health. */
  chat?: () => boolean;
  probeFinance: () => Promise<Reachability>;
  /**
   * False until boot recovery ran (which waits for a bot to be configured) and
   * during shutdown; the webhook answers 503 then, so Telegram retries.
   */
  isAccepting: () => boolean;
  /** A webhook arrived while not accepting: e.g. re-read the settings, a bot may just have been saved. */
  onClosedWebhook?: () => void;
  startedAt?: number;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const startedAt = options.startedAt ?? Date.now();

  app.get("/health", async (c) => {
    const financeApi = await options.probeFinance();
    return c.json({
      ok: true,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      mode: options.mode(),
      chat: options.chat?.() ?? false,
      // false while boot recovery runs (and during shutdown)
      accepting: options.isAccepting(),
      financeApi,
      queued: options.pipeline.size,
    });
  });

  const webhook = options.adapter.webhook;
  if (webhook) {
    app.post(webhook.path, async (c) => {
      if (!options.isAccepting()) {
        options.onClosedWebhook?.();
        return c.text(options.mode() === "unconfigured" ? "telegram not configured" : "not accepting", 503, { "Retry-After": "5" });
      }
      return webhook.handle(c.req.raw, options.pipeline.deliver);
    });
  }

  app.notFound((c) => c.text("not found", 404));
  app.onError((_error, c) => c.text("internal error", 500));
  return app;
}
