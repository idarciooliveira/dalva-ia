import { describe, expect, test, vi } from "vitest";

import type { Deliver } from "../src/channels/channel";
import { TELEGRAM_SECRET_HEADER, type TelegramApi } from "../src/channels/telegram/adapter";
import { createTelegramChannel, TelegramNotConfiguredError, type TelegramSettings } from "../src/channels/telegram/runtime";
import { createConfigSource, type RemoteConfig } from "../src/core/remote-config";
import { createPipeline } from "../src/core/pipeline";
import { createApp } from "../src/http";
import { createLogger } from "../src/log";
import { BOT_TOKEN, BOT_USERNAME, captureLogger, fakeFinance, fakeTelegramApi, fixture, textUpdate, waitFor, WEBHOOK_SECRET } from "./helpers";

const OTHER_TOKEN = "7000000002:AAH-other-bot-token-0123456789abcdefXYZ";
const OTHER_SECRET = "other-secret-0123456789abcdef0123456789ab";
const AI_KEY = "ai-key-0123456789abcdef";

const bot = (overrides: Partial<TelegramSettings> = {}): TelegramSettings => ({
  token: BOT_TOKEN,
  botUsername: BOT_USERNAME,
  webhookSecret: WEBHOOK_SECRET,
  delivery: "webhook",
  ...overrides,
});
const unset: RemoteConfig = { telegram: null, ai: null };

describe("config source", () => {
  function source(answers: Array<RemoteConfig | Error>, options: { minRefreshMs?: number } = {}) {
    let clock = 0;
    const load = vi.fn(async () => {
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      return next;
    });
    const { logger, lines } = captureLogger();
    const secrets: string[] = [];
    const config = createConfigSource({
      load,
      logger,
      minRefreshMs: options.minRefreshMs ?? 0,
      onSecrets: (values) => secrets.push(...values),
      now: () => clock,
    });
    const changes: RemoteConfig[] = [];
    config.onChange((next) => {
      changes.push(next);
    });
    return { config, load, changes, secrets, lines, tick: (ms: number) => (clock += ms) };
  }

  test("notifies on changes only, and hands the secrets to the scrubber", async () => {
    const withBot: RemoteConfig = { telegram: bot(), ai: { provider: "gateway", model: "vendor/model", apiKey: AI_KEY } };
    const { config, changes, secrets } = source([unset, unset, withBot, withBot]);
    expect(config.current).toBeNull();
    await config.refresh();
    await config.refresh();
    expect(changes).toEqual([unset]);
    await config.refresh();
    await config.refresh();
    expect(changes).toEqual([unset, withBot]);
    expect(config.current).toEqual(withBot);
    expect(secrets).toEqual(expect.arrayContaining([BOT_TOKEN, WEBHOOK_SECRET, AI_KEY]));
  });

  test("keeps the last config when a load fails, and logs the outage once", async () => {
    const { config, changes, lines } = source([unset, new Error("down"), new Error("down"), unset]);
    await config.refresh();
    await config.refresh();
    await config.refresh();
    expect(config.current).toEqual(unset);
    expect(lines.filter((line) => line.includes("config_load_failed"))).toHaveLength(1);
    await config.refresh();
    expect(lines.some((line) => line.includes("config_load_recovered"))).toBe(true);
    expect(changes).toHaveLength(1);
  });

  test("throttles and coalesces on-demand refreshes", async () => {
    const { config, load, tick } = source([unset], { minRefreshMs: 2_000 });
    await Promise.all([config.refresh(), config.refresh(), config.refresh()]);
    expect(load).toHaveBeenCalledTimes(1);
    await config.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    tick(2_000);
    await config.refresh();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("invalidate: the next load notifies again though nothing changed", async () => {
    const { config, changes } = source([unset]);
    await config.refresh();
    config.invalidate();
    await config.refresh();
    await config.refresh();
    expect(changes).toEqual([unset, unset]);
  });

  test("applies a config again when a listener failed on it", async () => {
    const { config, changes } = source([unset]);
    let fail = true;
    config.onChange(() => {
      if (fail) throw new Error("boom");
    });
    await config.refresh();
    fail = false;
    await config.refresh();
    expect(changes).toEqual([unset, unset]);
  });

  test("polls on an interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async () => unset);
      const config = createConfigSource({ load, logger: captureLogger().logger, intervalMs: 1_000 });
      config.start();
      await vi.advanceTimersByTimeAsync(3_100);
      expect(load).toHaveBeenCalledTimes(3);
      config.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Telegram channel with runtime settings", () => {
  function setup() {
    const apis = new Map<string, ReturnType<typeof fakeTelegramApi>>();
    let next: TelegramSettings | null = null;
    const channel = createTelegramChannel({
      logger: captureLogger().logger,
      api: (token) => {
        const api = fakeTelegramApi();
        apis.set(token, api);
        return api.api;
      },
      // What the config source does: load, then configure the channel when it changed.
      refresh: vi.fn(async () => {
        await channel.configure(next);
      }),
      pollRetryMs: 1,
    });
    const deliver = vi.fn<Deliver>(async () => "accepted");
    const post = (secret?: string) =>
      channel.webhook.handle(
        new Request("http://agent/webhooks/telegram", {
          method: "POST",
          headers: { "content-type": "application/json", ...(secret ? { [TELEGRAM_SECRET_HEADER]: secret } : {}) },
          body: JSON.stringify(fixture("private-text")),
        }),
        deliver,
      );
    return { channel, apis, deliver, post, saveInWebApp: (settings: TelegramSettings | null) => (next = settings) };
  }

  test("answers 503 without a bot, after checking for a new one", async () => {
    const { channel, post, deliver } = setup();
    const response = await post(WEBHOOK_SECRET);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("telegram not configured");
    expect(deliver).not.toHaveBeenCalled();
    await expect(channel.send({ chatId: "1" }, { type: "text", text: "hi" })).rejects.toBeInstanceOf(TelegramNotConfiguredError);
  });

  test("picks up a bot saved in the web app on its first webhook", async () => {
    const { channel, post, deliver, saveInWebApp, apis } = setup();
    saveInWebApp(bot());
    expect((await post(WEBHOOK_SECRET)).status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
    await channel.send({ chatId: "1" }, { type: "text", text: "hi" });
    expect(apis.get(BOT_TOKEN)!.sent).toHaveLength(1);
    expect(channel.delivery).toBe("webhook");
  });

  test("an unknown secret re-reads the settings first: a replaced bot works at once, a wrong secret stays 401", async () => {
    const { channel, post, saveInWebApp, apis } = setup();
    await channel.configure(bot());
    saveInWebApp(bot({ token: OTHER_TOKEN, webhookSecret: OTHER_SECRET }));
    expect((await post(OTHER_SECRET)).status).toBe(200);
    await channel.send({ chatId: "1" }, { type: "text", text: "hi" });
    expect(apis.get(OTHER_TOKEN)!.sent).toHaveLength(1);
    expect(apis.get(BOT_TOKEN)!.sent).toHaveLength(0);
    expect((await post(WEBHOOK_SECRET)).status).toBe(401);
    expect((await post()).status).toBe(401);
  });

  test("a removed bot answers 503 again", async () => {
    const { channel, post } = setup();
    await channel.configure(bot());
    await channel.configure(null);
    expect((await post(WEBHOOK_SECRET)).status).toBe(503);
    expect(channel.delivery).toBeNull();
  });

  test("polling delivery: no webhook (404); switching bots moves polling to the new one", async () => {
    const { channel, post } = setup();
    const polls: string[] = [];
    const pollingApi = (token: string) =>
      ({
        deleteWebhook: async () => true,
        getUpdates: async (_other: unknown, signal: AbortSignal) => {
          polls.push(token);
          return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
        },
      }) as unknown as TelegramApi;
    const polling = createTelegramChannel({ logger: captureLogger().logger, api: pollingApi, pollRetryMs: 1 });
    await polling.configure(bot({ delivery: "polling" }));
    await polling.start(async () => "accepted");
    await waitFor(() => polls.includes(BOT_TOKEN));
    await polling.configure(bot({ token: OTHER_TOKEN, delivery: "polling" }));
    await waitFor(() => polls.includes(OTHER_TOKEN));
    await polling.stop();
    expect(polls.filter((token) => token === BOT_TOKEN)).toHaveLength(1);

    await channel.configure(bot({ delivery: "polling" }));
    expect((await post(WEBHOOK_SECRET)).status).toBe(404);
  });

  test("a bot Telegram refuses to poll for leaves no bot, and the same settings can be applied again", async () => {
    let refuse = true;
    const deleteWebhook = vi.fn(async () => {
      if (refuse) throw Object.assign(new Error("Unauthorized"), { error_code: 401 });
      return true;
    });
    const api = () =>
      ({
        deleteWebhook,
        getUpdates: async (_other: unknown, signal: AbortSignal) =>
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      }) as unknown as TelegramApi;
    const channel = createTelegramChannel({ logger: captureLogger().logger, api, pollRetryMs: 1 });
    await channel.configure(bot({ delivery: "polling" }));
    await expect(channel.start(async () => "accepted")).rejects.toThrow("Unauthorized");
    expect(channel.delivery).toBeNull();
    // The next config load applies the same settings again: now it starts.
    refuse = false;
    await channel.configure(bot({ delivery: "polling" }));
    expect(channel.delivery).toBe("polling");
    expect(deleteWebhook).toHaveBeenCalledTimes(2);
    await channel.stop();
  });

  test("parses with the configured bot's username, and keeps it after removal (stored events)", async () => {
    const { channel } = setup();
    await channel.configure(bot());
    const mention = { ...textUpdate(1, `/balance@${BOT_USERNAME}`), message: { ...textUpdate(1, "").message, text: `/balance@${BOT_USERNAME}`, entities: [{ type: "bot_command", offset: 0, length: 9 + BOT_USERNAME.length }] } };
    expect(channel.parse(mention)).toMatchObject({ kind: "command", command: "balance" });
    await channel.configure(null);
    expect(channel.parse(mention)).toMatchObject({ kind: "command", command: "balance" });
  });
});

describe("agent HTTP before any settings", () => {
  test("health is ok and says unconfigured; the webhook answers 503 and asks for a re-read", async () => {
    const { logger } = captureLogger();
    const channel = createTelegramChannel({ logger });
    const finance = fakeFinance();
    const pipeline = createPipeline({ adapter: channel, service: finance.clients.service, handle: async () => {}, logger });
    const onClosedWebhook = vi.fn();
    const app = createApp({
      adapter: channel,
      pipeline,
      mode: () => channel.delivery ?? "unconfigured",
      chat: () => false,
      probeFinance: async () => "ok",
      isAccepting: () => false,
      onClosedWebhook,
    });
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, mode: "unconfigured", chat: false, accepting: false });
    const webhook = await app.request("/webhooks/telegram", { method: "POST", body: "{}" });
    expect(webhook.status).toBe(503);
    expect(await webhook.text()).toBe("telegram not configured");
    expect(onClosedWebhook).toHaveBeenCalledTimes(1);
  });
});

describe("log scrubbing with runtime secrets", () => {
  test("secrets learned after the logger was made are scrubbed from then on", () => {
    const lines: string[] = [];
    const secrets = new Set<string>();
    const logger = createLogger({ level: "info", secrets: () => secrets, write: (line) => lines.push(line) }).child({ scope: "x" });
    secrets.add(AI_KEY);
    logger.warn(`failed with ${AI_KEY}`, { detail: `key=${AI_KEY}` });
    expect(lines[0]).not.toContain(AI_KEY);
    expect(lines[0]).toContain("[redacted]");
  });
});
