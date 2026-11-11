import { createHash, timingSafeEqual } from "node:crypto";

// The web build uses the runtime's own fetch (Bun has one); the Node build pulls in node-fetch.
import { Api } from "grammy/web";
import type { InlineKeyboardMarkup, Update } from "grammy/types";

import { errorFields, type Logger } from "../../log";
import { encodeButtonPayload } from "../channel";
import type { ChannelAdapter, ChatAddress, Deliver, IntakeCapacity, OutboundMessage, WebhookIngress } from "../channel";
import { renderHtml } from "./format";
import { parseTelegramUpdate } from "./parse";

export const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";
export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const ALLOWED_UPDATES = ["message", "callback_query"] as const;
const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_UPDATES_PER_POLL = 100;
/** Long-poll wait inside getUpdates; the HTTP timeout must exceed it. */
const POLL_TIMEOUT_SECONDS = 25;
/** grammY's default is 500s: one hung call would block a chat's queue for minutes. */
const API_TIMEOUT_SECONDS = 30;
/** Telegram updates are small; anything bigger is not from Telegram. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** The Bot API methods the adapter uses (a grammY `Api`, or a fake in tests). */
export type TelegramApi = Pick<
  Api,
  "sendMessage" | "sendChatAction" | "answerCallbackQuery" | "getUpdates" | "deleteWebhook"
>;

export interface TelegramAdapterOptions {
  token: string;
  botUsername: string;
  mode: "webhook" | "polling";
  /** Required in webhook mode. */
  webhookSecret?: string;
  logger: Logger;
  api?: TelegramApi;
  /** Wait after a failed `getUpdates` before retrying. */
  pollRetryMs?: number;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time compare (both sides hashed, so length differences don't leak either). */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

function webhookIngress(secret: string, logger: Logger): WebhookIngress {
  return {
    path: TELEGRAM_WEBHOOK_PATH,
    async handle(request: Request, deliver: Deliver): Promise<Response> {
      if (!secretMatches(request.headers.get(TELEGRAM_SECRET_HEADER), secret)) {
        logger.warn("webhook_unauthorized");
        return new Response("unauthorized", { status: 401 });
      }
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_WEBHOOK_BODY_BYTES) return new Response("too large", { status: 413 });
      let body: unknown;
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) return new Response("too large", { status: 413 });
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // Telegram retries non-2xx later, which is what we want when we're full.
      const result = deliver(body);
      if (result === "overloaded") return new Response("busy", { status: 503, headers: { "Retry-After": "5" } });
      return new Response("ok", { status: 200 });
    },
  };
}

function inlineKeyboard(actionId: string): InlineKeyboardMarkup {
  const confirm = encodeButtonPayload("confirm", actionId);
  const cancel = encodeButtonPayload("cancel", actionId);
  if (new TextEncoder().encode(confirm).length > MAX_CALLBACK_DATA_BYTES) {
    throw new Error("Action id too long for a Telegram button");
  }
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: confirm },
        { text: "Cancel", callback_data: cancel },
      ],
    ],
  };
}

export function createTelegramAdapter(options: TelegramAdapterOptions): ChannelAdapter {
  const logger = options.logger.child({ channel: "telegram" });
  const api: TelegramApi = options.api ?? new Api(options.token, { timeoutSeconds: API_TIMEOUT_SECONDS });
  const pollRetryMs = options.pollRetryMs ?? 3000;

  if (options.mode === "webhook" && !options.webhookSecret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required in webhook mode");
  }

  let polling: { controller: AbortController; loop: Promise<void> } | null = null;

  async function pollLoop(deliver: Deliver, capacity: IntakeCapacity, signal: AbortSignal) {
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    let offset = 0;
    while (!signal.aborted) {
      try {
        await Promise.race([capacity.wait(), aborted]);
        if (signal.aborted) return;
        // Never fetch more than the pipeline can queue: fetched updates are confirmed by the next offset.
        const limit = Math.min(MAX_UPDATES_PER_POLL, capacity.available());
        if (limit <= 0) continue;
        const updates: Update[] = await api.getUpdates(
          { offset, limit, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: [...ALLOWED_UPDATES] },
          // grammY types its signal with an old AbortSignal shim; the runtime object is the standard one.
          signal as unknown as Parameters<TelegramApi["getUpdates"]>[1],
        );
        for (const update of updates) {
          if (deliver(update) === "overloaded") break; // Not confirmed: Telegram hands it out again next poll.
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.warn("poll_failed", errorFields(error));
        await Promise.race([new Promise((resolve) => setTimeout(resolve, pollRetryMs)), aborted]);
      }
    }
  }

  return {
    id: "telegram",
    webhook: options.mode === "webhook" ? webhookIngress(options.webhookSecret!, logger) : undefined,

    parse: (raw) => {
      try {
        return parseTelegramUpdate(raw, options.botUsername);
      } catch {
        return null;
      }
    },

    async send(to: ChatAddress, message: OutboundMessage) {
      if (message.type === "typing") {
        await api.sendChatAction(to.chatId, "typing");
        return;
      }
      const html = renderHtml(message.text);
      await api.sendMessage(to.chatId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(message.type === "confirm" ? { reply_markup: inlineKeyboard(message.actionId) } : {}),
      });
    },

    async answerButton(buttonId: string, text?: string) {
      await api.answerCallbackQuery(buttonId, text ? { text } : undefined);
    },

    async start(deliver, capacity) {
      if (options.mode !== "polling" || polling) return;
      // getUpdates fails while a webhook is set; keep pending updates so nothing is lost.
      await api.deleteWebhook({ drop_pending_updates: false });
      const controller = new AbortController();
      polling = { controller, loop: pollLoop(deliver, capacity, controller.signal) };
      logger.info("polling_started");
    },

    async stop() {
      if (!polling) return;
      polling.controller.abort();
      await polling.loop;
      polling = null;
      logger.info("polling_stopped");
    },
  };
}
