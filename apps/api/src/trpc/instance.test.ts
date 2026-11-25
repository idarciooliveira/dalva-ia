import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { clientFor, expectApiError, seedUser, serviceClientFor, tokenFor, type TestApp } from "../../test/api";
import { createTestUser, testApp } from "../../test/app";
import { testDb } from "../../test/db";
import { fakeTelegram, TelegramApiError } from "../../test/telegram";
import { createSecretBox } from "../auth/secret-box";
import { instanceSettings } from "../db/schema";
import { claimOwner } from "../domain/instance";
import { createLogger } from "../log";

const TOKEN = `777000111:${"A".repeat(31)}wxyz`;
const OTHER_TOKEN = `888000222:${"B".repeat(31)}abcd`;
const AI_KEY = "sk-or-v1-0123456789abcdef";
const HTTPS = "https://dalva.example.com";

/** Owner first: the earliest user owns the instance. */
async function setup(options: Parameters<typeof testApp>[0] = {}) {
  const telegram = fakeTelegram();
  const { app } = testApp({ publicUrl: HTTPS, telegram, ...options });
  const ownerId = await seedUser();
  const otherId = await seedUser();
  return {
    app,
    telegram,
    ownerId,
    owner: clientFor(app, await tokenFor(ownerId)),
    other: clientFor(app, await tokenFor(otherId)),
    service: serviceClientFor(app),
  };
}

const stored = async () => (await testDb().select().from(instanceSettings).where(eq(instanceSettings.id, 1)))[0];

describe("instance settings: owner", () => {
  it("the earliest user is the owner; others see nothing", async () => {
    const { owner, other } = await setup();
    expect(await owner.instance.get()).toEqual({ owner: true, telegram: { status: "unset" }, ai: { status: "unset" } });
    expect(await other.instance.get()).toEqual({ owner: false });
  });

  it("a stored owner wins over the earliest user", async () => {
    const { app, owner } = await setup();
    const laterId = await seedUser();
    await testDb().insert(instanceSettings).values({ id: 1, ownerUserId: laterId });
    expect(await clientFor(app, await tokenFor(laterId)).instance.get()).toMatchObject({ owner: true });
    expect(await owner.instance.get()).toEqual({ owner: false });
  });

  it("sign-up stores the first user as the owner and leaves it", async () => {
    const first = await createTestUser();
    await claimOwner(testDb());
    await createTestUser();
    await claimOwner(testDb());
    expect((await stored())?.ownerUserId).toBe(first);
  });

  it("refuses every write from others", async () => {
    const { other, telegram } = await setup();
    await expectApiError(other.instance.saveTelegram({ token: TOKEN }), "forbidden", 403);
    await expectApiError(other.instance.removeTelegram(), "forbidden", 403);
    await expectApiError(other.instance.telegramStatus(), "forbidden", 403);
    await expectApiError(other.instance.saveAi({ provider: "gateway", model: "vendor/model", apiKey: AI_KEY }), "forbidden", 403);
    expect(telegram.calls).toEqual([]);
    expect(await stored()).toBeUndefined();
  });
});

describe("instance settings: Telegram", () => {
  it("checks the token, sets the webhook with a generated secret, and stores the token sealed", async () => {
    const { owner, telegram } = await setup();
    const { telegram: state } = await owner.instance.saveTelegram({ token: ` ${TOKEN} ` });
    expect(state).toMatchObject({ status: "configured", botUsername: "bot_777000111", tokenHint: "wxyz", delivery: "webhook" });
    expect(JSON.stringify(state)).not.toContain(TOKEN);

    expect(telegram.calls.map((call) => call.method)).toEqual(["getMe", "setWebhook"]);
    const webhook = telegram.webhooks.get(TOKEN)!;
    expect(webhook.url).toBe(`${HTTPS}/webhooks/telegram`);
    expect(webhook.secretToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = (await stored())!;
    expect(row.telegramBotTokenSealed).not.toContain(TOKEN.split(":")[1]);
    expect(row.telegramWebhookSecretSealed).not.toContain(webhook.secretToken);
    expect(await owner.instance.get()).toMatchObject({ telegram: { status: "configured", botUsername: "bot_777000111" } });
  });

  it("only polls behind an http PUBLIC_URL (local dev): no webhook is set", async () => {
    const { owner, telegram } = await setup({ publicUrl: "http://localhost:3000" });
    expect((await owner.instance.saveTelegram({ token: TOKEN })).telegram).toMatchObject({ delivery: "polling" });
    expect(telegram.calls.map((call) => call.method)).toEqual(["getMe"]);
  });

  it("shows Telegram's refusal of the token and stores nothing", async () => {
    const { owner, telegram } = await setup();
    telegram.fail.getMe = new TelegramApiError("Unauthorized", 401);
    const error = await expectApiError(owner.instance.saveTelegram({ token: TOKEN }), "validation_failed", 400);
    expect(error.details).toEqual({ issues: [{ path: "token", message: "Telegram rejected this token. Copy it again from @BotFather." }] });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(await stored()).toBeUndefined();
  });

  it("shows Telegram's refusal of the webhook and stores nothing", async () => {
    const { owner, telegram } = await setup();
    telegram.fail.setWebhook = new TelegramApiError("Bad Request: bad webhook: Failed to resolve host", 400);
    const error = await expectApiError(owner.instance.saveTelegram({ token: TOKEN }), "validation_failed", 400);
    expect(error.message).toBe("Telegram refused the webhook: Bad Request: bad webhook: Failed to resolve host");
    expect(await stored()).toBeUndefined();
  });

  it("says when Telegram can't be reached", async () => {
    const { owner, telegram } = await setup();
    telegram.fail.getMe = new TelegramApiError("Couldn't reach Telegram", null);
    expect((await expectApiError(owner.instance.saveTelegram({ token: TOKEN }), "validation_failed")).message).toBe(
      "Couldn't reach Telegram. Try again in a moment.",
    );
  });

  it("validates the token's shape without quoting it", async () => {
    const { owner, telegram } = await setup();
    const error = await expectApiError(owner.instance.saveTelegram({ token: "not-a-token-secret-value" }), "validation_failed", 400);
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(telegram.calls).toEqual([]);
  });

  it("replacing the bot removes the previous bot's webhook and rotates the secret", async () => {
    const { owner, telegram, service } = await setup();
    await owner.instance.saveTelegram({ token: TOKEN });
    const first = (await service.instance.agentConfig()).telegram!.webhookSecret;
    await owner.instance.saveTelegram({ token: OTHER_TOKEN });
    expect(telegram.webhooks.has(TOKEN)).toBe(false);
    expect(telegram.webhooks.has(OTHER_TOKEN)).toBe(true);
    const config = (await service.instance.agentConfig()).telegram!;
    expect(config).toMatchObject({ token: OTHER_TOKEN, botUsername: "bot_888000222" });
    expect(config.webhookSecret).not.toBe(first);
    expect(config.webhookSecret).toBe(telegram.webhooks.get(OTHER_TOKEN)!.secretToken);
  });

  it("reports the webhook as Telegram sees it", async () => {
    const { owner, telegram } = await setup();
    expect(await owner.instance.telegramStatus()).toEqual({ status: "unset" });
    await owner.instance.saveTelegram({ token: TOKEN });
    telegram.info = { pendingUpdateCount: 2, lastErrorDate: 1_700_000_000, lastErrorMessage: "Connection timed out" };
    expect(await owner.instance.telegramStatus()).toEqual({
      status: "ok",
      delivery: "webhook",
      webhookUrl: `${HTTPS}/webhooks/telegram`,
      webhookMatches: true,
      pendingUpdateCount: 2,
      lastErrorAt: new Date(1_700_000_000_000).toISOString(),
      lastErrorMessage: "Connection timed out",
    });
    telegram.webhooks.set(TOKEN, { url: "https://elsewhere.test/hook?secret=1", secretToken: "x" });
    expect(await owner.instance.telegramStatus()).toMatchObject({ webhookUrl: "https://elsewhere.test/hook", webhookMatches: false });
    telegram.fail.getWebhookInfo = new TelegramApiError("Unauthorized", 401);
    expect(await owner.instance.telegramStatus()).toEqual({ status: "error", delivery: "webhook", message: "Unauthorized" });
  });

  it("removes the bot: deletes the webhook and forgets the token", async () => {
    const { owner, telegram, service } = await setup();
    await owner.instance.saveTelegram({ token: TOKEN });
    expect(await owner.instance.removeTelegram()).toEqual({ webhookDeleted: true });
    expect(telegram.webhooks.size).toBe(0);
    expect(await owner.instance.get()).toMatchObject({ telegram: { status: "unset" } });
    expect((await service.instance.agentConfig()).telegram).toBeNull();
    // Telegram failing doesn't keep a bot the owner wants gone.
    await owner.instance.saveTelegram({ token: TOKEN });
    telegram.fail.deleteWebhook = new TelegramApiError("Unauthorized", 401);
    expect(await owner.instance.removeTelegram()).toEqual({ webhookDeleted: false });
    expect(await owner.instance.get()).toMatchObject({ telegram: { status: "unset" } });
  });
});

describe("instance settings: AI provider", () => {
  it("stores provider, model and a sealed key; shows only the hint", async () => {
    const { owner, service } = await setup();
    const { ai } = await owner.instance.saveAi({ provider: "openrouter", model: "vendor/model-1", apiKey: AI_KEY });
    expect(ai).toMatchObject({ status: "configured", provider: "openrouter", model: "vendor/model-1", keyHint: "cdef" });
    expect(JSON.stringify(await owner.instance.get())).not.toContain(AI_KEY);
    expect((await stored())!.aiApiKeySealed).not.toContain(AI_KEY);
    expect((await service.instance.agentConfig()).ai).toEqual({ provider: "openrouter", model: "vendor/model-1", apiKey: AI_KEY });
  });

  it("keeps the stored key when none is sent, for the same provider only", async () => {
    const { owner, service } = await setup();
    await expectApiError(owner.instance.saveAi({ provider: "gateway", model: "vendor/model" }), "validation_failed");
    await owner.instance.saveAi({ provider: "gateway", model: "vendor/model", apiKey: AI_KEY });
    await owner.instance.saveAi({ provider: "gateway", model: "vendor/other" });
    expect((await service.instance.agentConfig()).ai).toEqual({ provider: "gateway", model: "vendor/other", apiKey: AI_KEY });
    const error = await expectApiError(owner.instance.saveAi({ provider: "openrouter", model: "vendor/other" }), "validation_failed");
    expect(error.details).toEqual({ issues: [{ path: "apiKey", message: "Enter the API key for this provider" }] });
  });

  it("validates model and key without quoting them", async () => {
    const { owner } = await setup();
    const error = await expectApiError(owner.instance.saveAi({ provider: "gateway", model: "bad model id!", apiKey: "k3y!" }), "validation_failed");
    expect(error.details).toMatchObject({ issues: [{ path: "model" }, { path: "apiKey" }] });
    expect(JSON.stringify(error)).not.toMatch(/bad model id|k3y!/);
  });
});

describe("instance settings: agent config and rotated secrets", () => {
  it("is empty until set, and service key only", async () => {
    const { app, service } = await setup();
    expect(await service.instance.agentConfig()).toEqual({ telegram: null, ai: null });
    const user = clientFor(app, await tokenFor(await seedUser()));
    await expectApiError(user.instance.agentConfig(), "unauthorized", 401);
  });

  it("after BETTER_AUTH_SECRET changes: unreadable for the owner, null for the agent, fixed by entering them again", async () => {
    const { owner, telegram } = await setup();
    await owner.instance.saveTelegram({ token: TOKEN });
    await owner.instance.saveAi({ provider: "gateway", model: "vendor/model", apiKey: AI_KEY });

    const rotated = testApp({ publicUrl: HTTPS, telegram, secretBox: createSecretBox("rotated-".repeat(5)) }).app;
    const ownerAfter = clientFor(rotated, await tokenFor((await stored())!.ownerUserId!));
    expect(await ownerAfter.instance.get()).toMatchObject({
      telegram: { status: "unreadable", botUsername: "bot_777000111", tokenHint: "wxyz" },
      ai: { status: "unreadable", provider: "gateway", keyHint: "cdef" },
    });
    expect(await ownerAfter.instance.telegramStatus()).toEqual({ status: "unreadable" });
    expect(await serviceClientFor(rotated).instance.agentConfig()).toEqual({ telegram: null, ai: null });
    // The key can't be kept: it no longer opens.
    await expectApiError(ownerAfter.instance.saveAi({ provider: "gateway", model: "vendor/model" }), "validation_failed");

    await ownerAfter.instance.saveTelegram({ token: TOKEN });
    await ownerAfter.instance.saveAi({ provider: "gateway", model: "vendor/model", apiKey: AI_KEY });
    expect(await serviceClientFor(rotated).instance.agentConfig()).toMatchObject({ telegram: { token: TOKEN }, ai: { apiKey: AI_KEY } });
  });

  it("hands every secret it reads or receives to the log scrubber", async () => {
    const lines: string[] = [];
    const seen = new Set<string>();
    const logger = createLogger({ level: "debug", secrets: () => seen, write: (line) => lines.push(line) });
    const { owner, service, telegram } = await setup({ logger, onSecret: (value) => seen.add(value) });
    await owner.instance.saveTelegram({ token: TOKEN });
    await owner.instance.saveAi({ provider: "gateway", model: "vendor/model", apiKey: AI_KEY });
    await service.instance.agentConfig();
    const webhookSecret = telegram.webhooks.get(TOKEN)!.secretToken;
    expect([...seen]).toEqual(expect.arrayContaining([TOKEN, AI_KEY, webhookSecret]));
    logger.error("oops", { detail: `token ${TOKEN} key ${AI_KEY} secret ${webhookSecret}` });
    expect(lines.at(-1)).not.toMatch(new RegExp(`${TOKEN}|${AI_KEY}|${webhookSecret}`));
  });
});

export type { TestApp };
