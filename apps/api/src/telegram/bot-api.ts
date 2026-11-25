/**
 * The few Telegram Bot API calls the instance settings make: check a token
 * (`getMe`), point the bot at the agent (`setWebhook`), read and remove that
 * (`getWebhookInfo`, `deleteWebhook`). Failures are `TelegramApiError` with
 * Telegram's description, any bot token scrubbed out of it.
 */

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
/** The agent's route, behind the web entry. Same path as the agent's `TELEGRAM_WEBHOOK_PATH`. */
export const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";
/** Updates the agent handles. */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;
const REQUEST_TIMEOUT_MS = 10_000;

/** Anything shaped like a bot token: the configured one, or another bot's in a URL. */
const TOKEN_LIKE = /\d+:[A-Za-z0-9_-]{30,}/g;
export const scrubTokens = (text: string) => text.replace(TOKEN_LIKE, "***");

export class TelegramApiError extends Error {
  override name = "TelegramApiError";
  constructor(
    /** Telegram's description, or what failed when no answer came back. Safe to show the owner. */
    readonly description: string,
    /** Telegram's `error_code` (401 for a revoked token), or null when Telegram didn't answer. */
    readonly status: number | null,
  ) {
    super(description);
  }
}

export interface BotInfo {
  id: number;
  username: string;
}

export interface WebhookInfo {
  url: string;
  pendingUpdateCount: number;
  /** Seconds since the epoch. */
  lastErrorDate?: number;
  lastErrorMessage?: string;
}

export interface TelegramBotApi {
  getMe(token: string): Promise<BotInfo>;
  setWebhook(token: string, args: { url: string; secretToken: string }): Promise<void>;
  getWebhookInfo(token: string): Promise<WebhookInfo>;
  deleteWebhook(token: string): Promise<void>;
}

export interface BotApiOptions {
  /** Default `https://api.telegram.org`. Tests point it at a stub. */
  origin?: string;
  fetch?: typeof fetch;
}

export function createTelegramBotApi(options: BotApiOptions = {}): TelegramBotApi {
  const origin = (options.origin ?? TELEGRAM_API_ORIGIN).replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  async function call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${origin}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The error can quote the request URL, which holds the token: never pass it on.
      throw new TelegramApiError("Couldn't reach Telegram", null);
    }
    let json: { ok?: unknown; result?: unknown; description?: unknown; error_code?: unknown };
    try {
      json = (await response.json()) as typeof json;
    } catch {
      throw new TelegramApiError(`Telegram answered HTTP ${response.status}`, response.status);
    }
    if (json.ok !== true) {
      const description = typeof json.description === "string" && json.description ? json.description : `HTTP ${response.status}`;
      const status = typeof json.error_code === "number" ? json.error_code : response.status;
      throw new TelegramApiError(scrubTokens(description).slice(0, 300), status);
    }
    return json.result as T;
  }

  return {
    async getMe(token) {
      const me = await call<{ id?: unknown; username?: unknown; is_bot?: unknown }>(token, "getMe");
      if (typeof me?.id !== "number" || typeof me.username !== "string" || me.is_bot !== true) {
        throw new TelegramApiError("Telegram didn't return a bot for this token", null);
      }
      return { id: me.id, username: me.username };
    },
    async setWebhook(token, args) {
      await call(token, "setWebhook", { url: args.url, secret_token: args.secretToken, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] });
    },
    async getWebhookInfo(token) {
      const info = await call<{ url?: unknown; pending_update_count?: unknown; last_error_date?: unknown; last_error_message?: unknown }>(
        token,
        "getWebhookInfo",
      );
      return {
        url: typeof info?.url === "string" ? info.url : "",
        pendingUpdateCount: typeof info?.pending_update_count === "number" ? info.pending_update_count : 0,
        ...(typeof info?.last_error_date === "number" ? { lastErrorDate: info.last_error_date } : {}),
        ...(typeof info?.last_error_message === "string" ? { lastErrorMessage: scrubTokens(info.last_error_message).slice(0, 300) } : {}),
      };
    },
    async deleteWebhook(token) {
      await call(token, "deleteWebhook", { drop_pending_updates: false });
    },
  };
}
