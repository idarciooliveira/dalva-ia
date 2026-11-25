import { describe, expect, it } from "vitest";

import { createTelegramBotApi, TelegramApiError } from "./bot-api";

const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function stub(answer: (url: string, body: unknown) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
    calls.push({ url, body });
    return await answer(url, body);
  }) as typeof globalThis.fetch;
  return { calls, api: createTelegramBotApi({ origin: "https://bot.test/", fetch }) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function rejection(promise: Promise<unknown>): Promise<TelegramApiError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(TelegramApiError);
  return error as TelegramApiError;
}

describe("Telegram Bot API client", () => {
  it("getMe returns the bot's id and username", async () => {
    const { api, calls } = stub(() => json({ ok: true, result: { id: 42, is_bot: true, username: "dalva_bot" } }));
    expect(await api.getMe(TOKEN)).toEqual({ id: 42, username: "dalva_bot" });
    expect(calls[0]!.url).toBe(`https://bot.test/bot${TOKEN}/getMe`);
  });

  it("setWebhook sends the url, secret and the updates the agent handles", async () => {
    const { api, calls } = stub(() => json({ ok: true, result: true }));
    await api.setWebhook(TOKEN, { url: "https://dalva.test/webhooks/telegram", secretToken: "s".repeat(43) });
    expect(calls[0]).toEqual({
      url: `https://bot.test/bot${TOKEN}/setWebhook`,
      body: { url: "https://dalva.test/webhooks/telegram", secret_token: "s".repeat(43), allowed_updates: ["message", "callback_query"] },
    });
  });

  it("maps getWebhookInfo and scrubs tokens from the last error", async () => {
    const { api } = stub(() =>
      json({ ok: true, result: { url: "https://dalva.test/webhooks/telegram", pending_update_count: 3, last_error_date: 1700000000, last_error_message: `Wrong response from ${TOKEN}` } }),
    );
    expect(await api.getWebhookInfo(TOKEN)).toEqual({
      url: "https://dalva.test/webhooks/telegram",
      pendingUpdateCount: 3,
      lastErrorDate: 1700000000,
      lastErrorMessage: "Wrong response from ***",
    });
  });

  it("turns Telegram's refusal into its description and code", async () => {
    const { api } = stub(() => json({ ok: false, error_code: 401, description: "Unauthorized" }, 401));
    const error = await rejection(api.getMe(TOKEN));
    expect(error.description).toBe("Unauthorized");
    expect(error.status).toBe(401);
  });

  it("never passes on a network error's message (it can quote the URL with the token)", async () => {
    const { api } = stub(() => {
      throw new TypeError(`fetch failed for https://bot.test/bot${TOKEN}/getMe`);
    });
    const error = await rejection(api.getMe(TOKEN));
    expect(error.description).toBe("Couldn't reach Telegram");
    expect(error.status).toBeNull();
    expect(error.message).not.toContain(TOKEN);
  });

  it("rejects a non-JSON answer and a token that isn't a bot", async () => {
    expect((await rejection(stub(() => new Response("<html>", { status: 502 })).api.getMe(TOKEN))).status).toBe(502);
    await rejection(stub(() => json({ ok: true, result: { id: 1, is_bot: false, username: "someone" } })).api.getMe(TOKEN));
  });

  it("scrubs tokens from descriptions", async () => {
    const { api } = stub(() => json({ ok: false, error_code: 400, description: `Bad Request: bot ${TOKEN} is odd` }, 400));
    expect((await rejection(api.setWebhook(TOKEN, { url: "https://x.test", secretToken: "s" }))).description).toBe("Bad Request: bot *** is odd");
  });
});
