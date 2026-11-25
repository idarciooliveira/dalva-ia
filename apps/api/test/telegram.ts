/**
 * A Telegram Bot API stand-in for API tests: answers like Telegram for any
 * well-formed token (the bot is `bot_<id>`), records every call, and fails a
 * method on demand (`fail.getMe = new TelegramApiError(...)`).
 */
import { type BotInfo, type TelegramBotApi, TelegramApiError, type WebhookInfo } from "../src/telegram/bot-api";

export interface FakeTelegram extends TelegramBotApi {
  calls: Array<{ method: keyof TelegramBotApi; token: string; args?: unknown }>;
  /** Webhook per token, as Telegram keeps it. */
  webhooks: Map<string, { url: string; secretToken: string }>;
  fail: Partial<Record<keyof TelegramBotApi, TelegramApiError>>;
  info: Partial<WebhookInfo>;
}

export const botIdOf = (token: string) => Number(token.split(":")[0]);

export function fakeTelegram(): FakeTelegram {
  const fake: FakeTelegram = {
    calls: [],
    webhooks: new Map(),
    fail: {},
    info: {},
    async getMe(token): Promise<BotInfo> {
      fake.calls.push({ method: "getMe", token });
      if (fake.fail.getMe) throw fake.fail.getMe;
      return { id: botIdOf(token), username: `bot_${botIdOf(token)}` };
    },
    async setWebhook(token, args) {
      fake.calls.push({ method: "setWebhook", token, args });
      if (fake.fail.setWebhook) throw fake.fail.setWebhook;
      fake.webhooks.set(token, args);
    },
    async getWebhookInfo(token) {
      fake.calls.push({ method: "getWebhookInfo", token });
      if (fake.fail.getWebhookInfo) throw fake.fail.getWebhookInfo;
      return { url: fake.webhooks.get(token)?.url ?? "", pendingUpdateCount: 0, ...fake.info };
    },
    async deleteWebhook(token) {
      fake.calls.push({ method: "deleteWebhook", token });
      if (fake.fail.deleteWebhook) throw fake.fail.deleteWebhook;
      fake.webhooks.delete(token);
    },
  };
  return fake;
}

export { TelegramApiError };
