/**
 * The Telegram channel with settings that change at runtime: the owner can
 * set, replace or remove the bot in the web app while the agent runs. Wraps a
 * `createTelegramAdapter` per bot and swaps it on `configure` (stopping and
 * restarting polling as needed); the pipeline and handler keep one adapter.
 *
 * Webhook route, before the inner adapter's own checks:
 * - no bot: 503 (Telegram retries), after one `refresh` in case it was just saved;
 * - polling delivery: 404, as without a webhook;
 * - an unknown secret: one `refresh` first, since a bot saved a moment ago
 *   already delivers with its new secret; still unknown, the inner adapter answers 401.
 */
import type { Logger } from "../../log";
import type { ChannelAdapter, ChatAddress, Deliver, OutboundMessage, SentRef, WebhookIngress } from "../channel";
import { createTelegramAdapter, secretMatches, TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH, type TelegramApi } from "./adapter";
import { parseTelegramUpdate, storableUpdate } from "./parse";

export interface TelegramSettings {
  token: string;
  botUsername: string;
  webhookSecret: string;
  delivery: "webhook" | "polling";
}

export interface TelegramChannel extends ChannelAdapter {
  readonly webhook: WebhookIngress;
  /** Switch to these settings (null: no bot). Resolves once the switch is done. */
  configure(settings: TelegramSettings | null): Promise<void>;
  /** The current delivery, or null without a bot. */
  readonly delivery: TelegramSettings["delivery"] | null;
}

export interface TelegramChannelOptions {
  logger: Logger;
  /** Re-read the settings now (the config source); `configure` runs inside it when they changed. */
  refresh?: () => Promise<unknown>;
  /** Bot API client per token (tests). Default: grammY's, built by the adapter. */
  api?: (token: string) => TelegramApi;
  pollRetryMs?: number;
}

export class TelegramNotConfiguredError extends Error {
  override name = "TelegramNotConfiguredError";
  constructor() {
    super("No Telegram bot is configured");
  }
}

const same = (a: TelegramSettings | null, b: TelegramSettings | null) =>
  a === b ||
  (a !== null && b !== null && a.token === b.token && a.botUsername === b.botUsername && a.webhookSecret === b.webhookSecret && a.delivery === b.delivery);

export function createTelegramChannel(options: TelegramChannelOptions): TelegramChannel {
  const logger = options.logger.child({ channel: "telegram" });
  let current: { settings: TelegramSettings; adapter: ChannelAdapter } | null = null;
  /** Kept after the bot is removed, so stored events still parse the same way. */
  let lastUsername = "";
  let deliver: Deliver | null = null;
  let stopped = false;
  let switching: Promise<void> = Promise.resolve();

  const active = (): ChannelAdapter => {
    if (!current) throw new TelegramNotConfiguredError();
    return current.adapter;
  };

  async function apply(next: TelegramSettings | null) {
    if (same(current?.settings ?? null, next)) return;
    const previous = current;
    current = null;
    if (previous) await previous.adapter.stop();
    if (!next) {
      logger.info("telegram_unconfigured");
      return;
    }
    const adapter = createTelegramAdapter({
      token: next.token,
      botUsername: next.botUsername,
      mode: next.delivery,
      webhookSecret: next.webhookSecret,
      logger: options.logger,
      api: options.api?.(next.token),
      pollRetryMs: options.pollRetryMs,
    });
    current = { settings: next, adapter };
    lastUsername = next.botUsername;
    logger.info("telegram_configured", { delivery: next.delivery, bot: next.botUsername });
    if (deliver && !stopped) {
      try {
        await adapter.start(deliver);
      } catch (error) {
        // Not this bot then: the next config load applies it again.
        current = null;
        throw error;
      }
    }
  }

  const webhook: WebhookIngress = {
    path: TELEGRAM_WEBHOOK_PATH,
    async handle(request, deliverEvent) {
      if (!current) await options.refresh?.();
      if (!current) return new Response("telegram not configured", { status: 503, headers: { "Retry-After": "30" } });
      if (current.settings.delivery !== "webhook") return new Response("not found", { status: 404 });
      if (!secretMatches(request.headers.get(TELEGRAM_SECRET_HEADER), current.settings.webhookSecret)) await options.refresh?.();
      const inner = current?.adapter.webhook;
      if (!inner) return new Response("telegram not configured", { status: 503, headers: { "Retry-After": "30" } });
      return inner.handle(request, deliverEvent);
    },
  };

  return {
    id: "telegram",
    webhook,
    get delivery() {
      return current?.settings.delivery ?? null;
    },

    configure(settings) {
      const done = switching.then(() => apply(settings));
      // The chain survives a failed switch; the caller still sees it fail.
      switching = done.catch(() => {});
      return done;
    },

    parse: (raw) => {
      try {
        return parseTelegramUpdate(raw, current?.settings.botUsername ?? lastUsername);
      } catch {
        return null;
      }
    },
    storable: (raw) => storableUpdate(raw),

    send: async (to: ChatAddress, message: OutboundMessage): Promise<SentRef | void> => await active().send(to, message),
    editMessage: async (to, messageRef, message) => await active().editMessage(to, messageRef, message),
    answerButton: async (buttonId, text) => await active().answerButton(buttonId, text),

    async start(deliverEvent) {
      deliver = deliverEvent;
      await switching;
      if (!current || stopped) return;
      try {
        await current.adapter.start(deliverEvent);
      } catch (error) {
        // Polling refused (revoked token): no bot until the settings are applied again.
        current = null;
        throw error;
      }
    },

    async stop() {
      stopped = true;
      await switching;
      await current?.adapter.stop();
    },
  };
}
