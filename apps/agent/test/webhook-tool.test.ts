import { describe, expect, test, vi } from "vitest";

import { buildDeleteWebhook, buildGetWebhookInfo, buildSetWebhook, runWebhookCommand, webhookUrl } from "../src/tools/telegram-webhook";
import { BOT_TOKEN, WEBHOOK_SECRET } from "./helpers";

const env = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  AGENT_PUBLIC_URL: "https://agent.example.com",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function run(command: string, overrides: Record<string, string | undefined>, fetchImpl: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runWebhookCommand(command, { ...env, ...overrides }, { fetch: fetchImpl, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("webhookUrl", () => {
  test("appends the webhook path to the origin", () => {
    expect(webhookUrl(env)).toBe("https://agent.example.com/webhooks/telegram");
    expect(webhookUrl({ ...env, AGENT_PUBLIC_URL: "https://agent.example.com/" })).toBe("https://agent.example.com/webhooks/telegram");
  });

  test.each([
    ["http://agent.example.com", "https"],
    ["https://agent.example.com/webhooks/telegram", "origin only"],
    ["https://agent.example.com?x=1", "origin only"],
    ["https://user:pw@agent.example.com", "origin only"],
    ["not a url", "URL"],
    ["", "required"],
  ])("rejects %j", (value, message) => {
    expect(() => webhookUrl({ ...env, AGENT_PUBLIC_URL: value })).toThrow(message);
  });
});

describe("buildSetWebhook", () => {
  test("posts url, secret_token and allowed_updates to setWebhook", () => {
    const req = buildSetWebhook(env);
    expect(req.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`);
    expect(req.init.method).toBe("POST");
    expect(req.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(req.init.body)).toEqual({
      url: "https://agent.example.com/webhooks/telegram",
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });
  });

  test.each(["1", "true", "TRUE"])("DROP_PENDING_UPDATES=%s adds drop_pending_updates", (value) => {
    expect(JSON.parse(buildSetWebhook({ ...env, DROP_PENDING_UPDATES: value }).init.body)).toMatchObject({ drop_pending_updates: true });
  });

  test.each(["", "0", "false"])("DROP_PENDING_UPDATES=%j keeps pending updates", (value) => {
    expect(JSON.parse(buildSetWebhook({ ...env, DROP_PENDING_UPDATES: value }).init.body)).not.toHaveProperty("drop_pending_updates");
  });

  test("validates token and secret without echoing them", () => {
    expect(() => buildSetWebhook({ ...env, TELEGRAM_BOT_TOKEN: undefined })).toThrow("TELEGRAM_BOT_TOKEN is required");
    expect(() => buildSetWebhook({ ...env, TELEGRAM_WEBHOOK_SECRET: undefined })).toThrow("TELEGRAM_WEBHOOK_SECRET is required");
    // base64 characters are not allowed by Telegram or by the agent's config
    const bad = "abc+def/ghi=abc+def/ghi=abc+def/ghi=abc+def/ghi=";
    expect(() => buildSetWebhook({ ...env, TELEGRAM_WEBHOOK_SECRET: bad })).toThrow("TELEGRAM_WEBHOOK_SECRET must be");
    try {
      buildSetWebhook({ ...env, TELEGRAM_WEBHOOK_SECRET: bad });
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
    expect(() => buildSetWebhook({ ...env, TELEGRAM_BOT_TOKEN: "nope" })).toThrow("TELEGRAM_BOT_TOKEN must look like");
  });
});

describe("buildGetWebhookInfo / buildDeleteWebhook", () => {
  test("getWebhookInfo carries nothing but the token in the URL", () => {
    const req = buildGetWebhookInfo({ TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    expect(req.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    expect(req.init.body).toBe("{}");
  });

  test("deleteWebhook keeps pending updates unless asked", () => {
    expect(JSON.parse(buildDeleteWebhook(env).init.body)).toEqual({});
    expect(JSON.parse(buildDeleteWebhook({ ...env, DROP_PENDING_UPDATES: "1" }).init.body)).toEqual({ drop_pending_updates: true });
  });
});

describe("runWebhookCommand", () => {
  test("set calls Telegram once and prints no secret", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: true }));
    const { code, out } = run("set", {}, fetchMock as unknown as typeof fetch);
    expect(await code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/setWebhook");
    expect(JSON.parse(init.body as string)).toMatchObject({ secret_token: WEBHOOK_SECRET });
    const output = out.join("\n");
    expect(output).toContain("https://agent.example.com/webhooks/telegram");
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain(WEBHOOK_SECRET);
  });

  test("info prints status, trims the URL to host and path, and redacts secrets", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        ok: true,
        result: {
          url: `https://agent.example.com/webhooks/telegram?token=${BOT_TOKEN}`,
          pending_update_count: 3,
          allowed_updates: ["message", "callback_query"],
          max_connections: 40,
          ip_address: "203.0.113.7",
          last_error_date: 1762860000,
          last_error_message: `Wrong response from the webhook: 401 Unauthorized ${WEBHOOK_SECRET}`,
        },
      }),
    );
    const { code, out } = run("info", {}, fetchMock as unknown as typeof fetch);
    expect(await code).toBe(0);
    const output = out.join("\n");
    expect(output).toContain("url:             https://agent.example.com/webhooks/telegram\n");
    expect(output).toContain("pending updates: 3");
    expect(output).toContain("message, callback_query");
    expect(output).toContain("401 Unauthorized [redacted]");
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain(WEBHOOK_SECRET);
  });

  test("info works without AGENT_PUBLIC_URL or a webhook secret", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: { url: "" } }));
    const { code, out } = run("info", { AGENT_PUBLIC_URL: undefined, TELEGRAM_WEBHOOK_SECRET: undefined }, fetchMock as unknown as typeof fetch);
    expect(await code).toBe(0);
    expect(out.join("\n")).toContain("url:             (none)");
    expect(out.join("\n")).toContain("last error:      none");
  });

  test("delete reports whether pending updates were dropped", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: true }));
    const kept = run("delete", {}, fetchMock as unknown as typeof fetch);
    expect(await kept.code).toBe(0);
    expect(kept.out.join("\n")).toContain("kept");
    const dropped = run("delete", { DROP_PENDING_UPDATES: "1" }, fetchMock as unknown as typeof fetch);
    expect(await dropped.code).toBe(0);
    expect(dropped.out.join("\n")).toContain("dropped");
  });

  test("a Telegram rejection exits 1 with the description", async () => {
    const fetchMock = vi.fn(async () => json({ ok: false, description: "Unauthorized" }, 401));
    const { code, err } = run("set", {}, fetchMock as unknown as typeof fetch);
    expect(await code).toBe(1);
    expect(err.join("\n")).toContain("Unauthorized");
    expect(err.join("\n")).not.toContain(BOT_TOKEN);
  });

  test("a network error never leaks the token from the request URL", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND for ${String(url)}`);
    });
    const { code, err } = run("info", {}, fetchMock as unknown as typeof fetch);
    expect(await code).toBe(1);
    expect(err.join("\n")).toContain("request failed");
    expect(err.join("\n")).not.toContain(BOT_TOKEN);
  });

  test("a non-JSON answer exits 1", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const { code, err } = run("info", {}, fetchMock as unknown as typeof fetch);
    expect(await code).toBe(1);
    expect(err.join("\n")).toContain("HTTP 502");
  });

  test("config errors never reach fetch; unknown commands exit 2", async () => {
    const fetchMock = vi.fn();
    const missing = run("set", { AGENT_PUBLIC_URL: undefined }, fetchMock as unknown as typeof fetch);
    expect(await missing.code).toBe(1);
    expect(missing.err.join("\n")).toContain("AGENT_PUBLIC_URL is required");
    const unknown = run("nope", {}, fetchMock as unknown as typeof fetch);
    expect(await unknown.code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
