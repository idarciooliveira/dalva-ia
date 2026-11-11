import { createHash, timingSafeEqual } from "node:crypto";

// The web build uses the runtime's own fetch (Bun has one); the Node build pulls in node-fetch.
import { Api } from "grammy/web";
import type { InlineKeyboardMarkup, Update } from "grammy/types";

import { errorFields, type Logger } from "../../log";
import { encodeButtonPayload, isAcknowledgeable } from "../channel";
import type { ChannelAdapter, ChatAddress, Deliver, OutboundMessage, SentRef, WebhookIngress } from "../channel";
import { renderHtmlChunks } from "./format";
import { parseTelegramUpdate, storableUpdate } from "./parse";

export const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";
export const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const ALLOWED_UPDATES = ["message", "callback_query"] as const;
const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_UPDATES_PER_POLL = 100;
const MAX_MESSAGE_CHARS = 4096;
/** Long-poll wait inside getUpdates; the HTTP timeout must exceed it. */
const POLL_TIMEOUT_SECONDS = 25;
/** grammY's default is 500s: one hung call would block a chat's queue for minutes. */
const API_TIMEOUT_SECONDS = 30;
/** Telegram updates are small; anything bigger is not from Telegram. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** The Bot API methods the adapter uses (a grammY `Api`, or a fake in tests). */
export type TelegramApi = Pick<
  Api,
  "sendMessage" | "editMessageText" | "sendChatAction" | "answerCallbackQuery" | "getUpdates" | "deleteWebhook"
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
      // 200 only once the event is stored (or needs nothing): anything else, Telegram redelivers later.
      const result = await deliver(body);
      if (!isAcknowledgeable(result)) return new Response("retry later", { status: 503, headers: { "Retry-After": "5" } });
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
  let stopped = false;

  /**
   * Dev-only intake: one update at a time. `offset` (which the next
   * getUpdates confirms to Telegram) only moves past an update once it is
   * stored; on a full queue or a failed claim we back off and fetch it again.
   */
  async function pollLoop(deliver: Deliver, signal: AbortSignal) {
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    const backOff = () => Promise.race([new Promise((resolve) => setTimeout(resolve, pollRetryMs)), aborted]);
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates: Update[] = await api.getUpdates(
          { offset, limit: MAX_UPDATES_PER_POLL, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: [...ALLOWED_UPDATES] },
          // grammY types its signal with an old AbortSignal shim; the runtime object is the standard one.
          signal as unknown as Parameters<TelegramApi["getUpdates"]>[1],
        );
        for (const update of updates) {
          if (signal.aborted) return;
          if (!isAcknowledgeable(await deliver(update))) {
            await backOff();
            break;
          }
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.warn("poll_failed", errorFields(error));
        await backOff();
      }
    }
  }

  return {
    id: "telegram",
    webhook: options.mode === "webhook" ? webhookIngress(options.webhookSecret!, logger) : undefined,

    storable: (raw) => storableUpdate(raw),

    parse: (raw) => {
      try {
        return parseTelegramUpdate(raw, options.botUsername);
      } catch {
        return null;
      }
    },

    async send(to: ChatAddress, message: OutboundMessage): Promise<SentRef | void> {
      if (message.type === "typing") {
        await api.sendChatAction(to.chatId, "typing");
        return;
      }
      // Telegram caps a message at 4096 characters: long texts go out as several, buttons on the last.
      const chunks = renderHtmlChunks(message.text, MAX_MESSAGE_CHARS);
      let ref: SentRef | undefined;
      for (const [index, html] of chunks.entries()) {
        const last = index === chunks.length - 1;
        const sent = await api.sendMessage(to.chatId, html, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(last && message.type === "confirm" ? { reply_markup: inlineKeyboard(message.actionId) } : {}),
        });
        if (sent?.message_id !== undefined) ref = { messageRef: String(sent.message_id) };
      }
      return ref;
    },

    async editMessage(to, messageRef, message) {
      // An edit is one message: a text past the limit keeps its first chunk.
      const html = renderHtmlChunks(message.text, MAX_MESSAGE_CHARS)[0] ?? "";
      try {
        await api.editMessageText(to.chatId, Number(messageRef), html, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: message.type === "confirm" ? inlineKeyboard(message.actionId) : { inline_keyboard: [] },
        });
      } catch (error) {
        // A replayed edit (recovery, double press) lands on a message that already shows it.
        if (/message is not modified/i.test(String((error as { description?: unknown })?.description ?? ""))) return;
        throw error;
      }
    },

    async answerButton(buttonId: string, text?: string) {
      await api.answerCallbackQuery(buttonId, text ? { text } : undefined);
    },

    async start(deliver) {
      if (options.mode !== "polling" || polling || stopped) return;
      // getUpdates fails while a webhook is set; keep pending updates so nothing is lost.
      await api.deleteWebhook({ drop_pending_updates: false });
      if (stopped) return; // stop() ran while we were waiting
      const controller = new AbortController();
      polling = { controller, loop: pollLoop(deliver, controller.signal) };
      logger.info("polling_started");
    },

    async stop() {
      stopped = true;
      if (!polling) return;
      polling.controller.abort();
      await polling.loop;
      polling = null;
      logger.info("polling_stopped");
    },
  };
}
