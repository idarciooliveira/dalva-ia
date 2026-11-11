import { describe, expect, test, vi } from "vitest";

import { secretMatches, TELEGRAM_SECRET_HEADER } from "../src/channels/telegram/adapter";
import { createPipeline } from "../src/core/pipeline";
import { createApp } from "../src/http";
import { captureLogger, fakeFinance, fixture, telegramAdapter, WEBHOOK_SECRET } from "./helpers";

function setup(options: { ready?: boolean } = {}) {
  const { logger } = captureLogger();
  const { adapter } = telegramAdapter(logger, "webhook");
  const finance = fakeFinance();
  const handle = vi.fn(async () => {});
  const pipeline = createPipeline({ adapter, service: finance.clients.service, handle, logger });
  const app = createApp({
    adapter,
    pipeline,
    mode: "webhook",
    probeFinance: async () => "ok",
    isReady: () => options.ready ?? true,
  });
  const post = (body: unknown, secret?: string) =>
    app.request("/webhooks/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret === undefined ? {} : { [TELEGRAM_SECRET_HEADER]: secret }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, post, handle, pipeline, finance };
}

describe("webhook", () => {
  test("constant-time secret check", () => {
    expect(secretMatches(WEBHOOK_SECRET, WEBHOOK_SECRET)).toBe(true);
    expect(secretMatches(`${WEBHOOK_SECRET}x`, WEBHOOK_SECRET)).toBe(false);
    expect(secretMatches("", WEBHOOK_SECRET)).toBe(false);
    expect(secretMatches(null, WEBHOOK_SECRET)).toBe(false);
  });

  test("401 without or with a wrong secret, and nothing is queued", async () => {
    const { post, pipeline } = setup();
    expect((await post(fixture("private-text"))).status).toBe(401);
    expect((await post(fixture("private-text"), "wrong")).status).toBe(401);
    expect(pipeline.size).toBe(0);
  });

  test("200 right away; processing runs in the background", async () => {
    const { post, finance } = setup();
    const release = finance.hold("POST /agent/events/claim");
    const response = await post(fixture("private-text"), WEBHOOK_SECRET);
    expect(response.status).toBe(200);
    release();
  });

  test("413 on an oversized body", async () => {
    const { post } = setup();
    const response = await post(JSON.stringify({ update_id: 1, pad: "é".repeat(600_000) }), WEBHOOK_SECRET);
    expect(response.status).toBe(413);
  });

  test("400 on a body that isn't JSON", async () => {
    const { post } = setup();
    expect((await post("{not json", WEBHOOK_SECRET)).status).toBe(400);
  });

  test("200 for updates the agent ignores", async () => {
    const { post, pipeline } = setup();
    expect((await post(fixture("edited-message"), WEBHOOK_SECRET)).status).toBe(200);
    expect(pipeline.size).toBe(0);
  });

  test("503 before boot recovery finished, so Telegram retries", async () => {
    const { post } = setup({ ready: false });
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(503);
  });

  test("health reports mode, uptime and finance reachability without secrets", async () => {
    const { app } = setup();
    const response = await app.request("/health");
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, mode: "webhook", financeApi: "ok" });
    expect(typeof body.uptime).toBe("number");
    expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
  });

  test("no webhook route in polling mode", async () => {
    const { logger } = captureLogger();
    const { adapter } = telegramAdapter(logger, "polling");
    const finance = fakeFinance();
    const pipeline = createPipeline({ adapter, service: finance.clients.service, handle: async () => {}, logger });
    const app = createApp({ adapter, pipeline, mode: "polling", probeFinance: async () => "ok", isReady: () => true });
    const response = await app.request("/webhooks/telegram", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });
});
