import { describe, expect, test, vi } from "vitest";

import { secretMatches, TELEGRAM_SECRET_HEADER } from "../src/channels/telegram/adapter";
import { createPipeline } from "../src/core/pipeline";
import { createApp } from "../src/http";
import { captureLogger, fakeFinance, fixture, telegramAdapter, WEBHOOK_SECRET } from "./helpers";

function setup(options: { accepting?: () => boolean; limits?: { maxPerChat?: number; maxTotal?: number } } = {}) {
  const { logger } = captureLogger();
  const { adapter } = telegramAdapter(logger, "webhook");
  const finance = fakeFinance();
  const handle = vi.fn(async () => {});
  const pipeline = createPipeline({ adapter, service: finance.clients.service, handle, logger, limits: options.limits, retryDelayMs: 1 });
  const app = createApp({
    adapter,
    pipeline,
    mode: "webhook",
    probeFinance: async () => "ok",
    isAccepting: options.accepting ?? (() => true),
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

  test("200 only once the event is stored; handling runs in the background", async () => {
    const { post, finance, handle, pipeline } = setup();
    const gate = finance.hold("POST /agent/events/status");
    const response = await post(fixture("private-text"), WEBHOOK_SECRET);
    expect(response.status).toBe(200);
    expect(finance.events.get("900000001")).toMatchObject({ status: "received" });
    expect(handle).not.toHaveBeenCalled();
    gate();
    await pipeline.shutdown(1000);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  test("a failed claim answers 503 so Telegram redelivers; nothing is handled", async () => {
    const { post, finance, handle, pipeline } = setup();
    finance.fail("POST /agent/events/claim", "network", 3);
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(503);
    await pipeline.shutdown(1000);
    expect(handle).not.toHaveBeenCalled();
  });

  test("a full queue answers 503 without claiming", async () => {
    const { post, finance } = setup({ limits: { maxPerChat: 1 } });
    const gate = finance.hold("POST /agent/events/status");
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(200);
    const second = { ...fixture("private-text"), update_id: 900000099 };
    expect((await post(second, WEBHOOK_SECRET)).status).toBe(503);
    expect(finance.callsTo("/agent/events/claim")).toHaveLength(1);
    gate();
  });

  test("a redelivered (duplicate) update is acknowledged", async () => {
    const { post } = setup();
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(200);
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(200);
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

  test("503 while boot recovery runs, without touching the backend; 200 once intake opens", async () => {
    let accepting = false;
    const { post, finance, app } = setup({ accepting: () => accepting });
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(503);
    expect(finance.calls).toHaveLength(0);
    expect(await (await app.request("/health")).json()).toMatchObject({ accepting: false });
    accepting = true;
    expect((await post(fixture("private-text"), WEBHOOK_SECRET)).status).toBe(200);
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
    const app = createApp({ adapter, pipeline, mode: "polling", probeFinance: async () => "ok", isAccepting: () => true });
    const response = await app.request("/webhooks/telegram", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });
});
