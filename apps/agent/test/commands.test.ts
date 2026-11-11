import { describe, expect, test } from "vitest";

import { createHandler } from "../src/core/handler";
import { createPipeline } from "../src/core/pipeline";
import { formatMoney } from "../src/core/money";
import { userMessageContent } from "../src/core/session";
import { captureLogger, fakeFinance, fixture, telegramAdapter, textUpdate } from "./helpers";

const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const USER = "424242";

function setup() {
  const { logger, lines } = captureLogger();
  const { adapter, telegram } = telegramAdapter(logger);
  const finance = fakeFinance();
  const { handle, onFailure, accept } = createHandler({ adapter, clients: finance.clients, logger, sessionIdleMinutes: 30 });
  let nextId = 1000;
  // One pipeline per update: shutdown() drains it, so each call returns once the update is fully handled.
  const run = async (text: string, userId = Number(USER), chatId = userId) => {
    const p = createPipeline({ adapter, service: finance.clients.service, handle, onFailure, accept, logger });
    p.deliver(textUpdate(nextId++, text, userId, chatId));
    await p.shutdown(2000);
  };
  const runUpdate = async (update: unknown) => {
    const p = createPipeline({ adapter, service: finance.clients.service, handle, onFailure, accept, logger });
    p.deliver(update);
    await p.shutdown(2000);
  };
  const lastReply = () => telegram.sent[telegram.sent.length - 1]?.html ?? "";
  return { finance, telegram, lines, run, runUpdate, lastReply };
}

describe("identity", () => {
  test("/start <code> links the chat", async () => {
    const { finance, run, lastReply } = setup();
    finance.codes.set(CODE, "valid");
    await run(`/start ${CODE}`);
    expect(lastReply()).toContain("Connected.");
    expect(finance.identities.get(USER)).toMatchObject({ chatId: USER });
    expect(finance.callsTo("/channel-links/redeem")[0]!.body).toMatchObject({
      channel: "telegram",
      code: CODE,
      externalUserId: USER,
      chatId: USER,
      username: `user${USER}`,
    });
  });

  test("an invalid or expired code gets a friendly message", async () => {
    const { finance, run, lastReply } = setup();
    await run(`/start ${CODE}`);
    expect(lastReply()).toContain("invalid or has expired");
    expect(finance.identities.size).toBe(0);
  });

  test("a malformed code never reaches the API", async () => {
    const { finance, run, lastReply } = setup();
    await run("/start bad!code");
    expect(lastReply()).toContain("invalid or has expired");
    expect(finance.callsTo("/channel-links/redeem")).toHaveLength(0);
  });

  test("already linked", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    finance.codes.set(CODE, "valid");
    await run(`/start ${CODE}`);
    expect(lastReply()).toContain("already connected");
  });

  test("an ambiguous redeem failure is settled with resolve", async () => {
    const { finance, run, lastReply } = setup();
    finance.fail("POST /channel-links/redeem", "network");
    finance.link(USER); // the redeem went through before the connection dropped
    await run(`/start ${CODE}`);
    expect(lastReply()).toContain("Connected.");
  });

  test("a re-processed /start <code> that already linked says connected, not invalid", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER); // our first attempt redeemed the code, then the process crashed
    await run(`/start ${CODE}`);
    expect(finance.callsTo("/channel-links/redeem")).toHaveLength(1);
    expect(lastReply()).toContain("Connected.");
  });

  test("rate limiting on resolve gets its own reply", async () => {
    const { finance, run, lastReply } = setup();
    finance.fail("POST /channel-identities/resolve", "rate_limited");
    await run("/balance");
    expect(lastReply()).toContain("Too many requests");
    expect([...finance.events.values()].at(-1)).toMatchObject({ status: "done" });
  });

  test("unlinked chats get instructions to connect from Settings → Telegram", async () => {
    const { run, lastReply } = setup();
    await run("/balance");
    expect(lastReply()).toContain("isn't connected");
    expect(lastReply()).toContain("Settings → Telegram");
    await run("hello there");
    expect(lastReply()).toContain("Settings → Telegram");
  });

  test("resolve is called with the chat id on every message", async () => {
    const { finance, run } = setup();
    finance.link(USER);
    await run("/help");
    await run("/help");
    const resolves = finance.callsTo("/channel-identities/resolve");
    expect(resolves).toHaveLength(2);
    expect(resolves[0]!.body).toEqual({ channel: "telegram", externalUserId: USER, chatId: USER });
  });
});

describe("commands", () => {
  test("/start without a code: welcome and how to link", async () => {
    const { run, lastReply } = setup();
    await run("/start");
    expect(lastReply()).toContain("Welcome to DALVA");
    expect(lastReply()).toContain("Settings → Telegram");
  });

  test("/start when linked: welcome back with the name, HTML-escaped", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER, { displayName: "<Ana>" });
    await run("/start");
    expect(lastReply()).toContain("Welcome back, &lt;Ana&gt;.");
  });

  test("/help works linked and unlinked", async () => {
    const { finance, run, lastReply } = setup();
    await run("/help");
    expect(lastReply()).toContain("/balance");
    expect(lastReply()).toContain("Settings → Telegram");
    finance.link(USER);
    await run("/help");
    expect(lastReply()).toContain("/balance");
    expect(lastReply()).not.toContain("Settings → Telegram");
  });

  test("/balance formats 0-, 2- and 3-decimal currencies with totals per currency", async () => {
    const { finance, run, lastReply, telegram } = setup();
    finance.link(USER);
    finance.accounts.push(
      { id: "acc_1", name: "Checking & Co", type: "bank", balance: { amountMinor: 123456789, currency: "USD" } },
      { id: "acc_2", name: "Card", type: "credit_card", balance: { amountMinor: -5005, currency: "USD" } },
      { id: "acc_3", name: "Tokyo", type: "cash", balance: { amountMinor: 1500000, currency: "JPY" } },
      { id: "acc_4", name: "Kuwait", type: "bank", balance: { amountMinor: 1234, currency: "KWD" } },
      { id: "acc_5", name: "Old", type: "bank", balance: { amountMinor: 1, currency: "USD" }, archived: true },
    );
    await run("/balance");
    const html = lastReply();
    expect(html).toContain("Checking &amp; Co: <code>1,234,567.89 USD</code>");
    expect(html).toContain("Card: <code>-50.05 USD</code>");
    expect(html).toContain("Tokyo: <code>1,500,000 JPY</code>");
    expect(html).toContain("Kuwait: <code>1.234 KWD</code>");
    expect(html).not.toContain("Old");
    expect(html).toContain("<b>Total: </b><code>1,234,517.84 USD</code>");
    expect(html).toContain("<b>Total: </b><code>1,500,000 JPY</code>");
    expect(telegram.actions).toContainEqual({ chatId: USER, action: "typing" });
    expect(finance.callsTo("/accounts")[0]!.auth).toBe(`Bearer tok_${USER}`);
  });

  test("/balance with no accounts", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    await run("/balance");
    expect(lastReply()).toContain("no accounts yet");
  });

  test("formatMoney", () => {
    expect(formatMoney(0, "JPY")).toBe("0 JPY");
    expect(formatMoney(5, "USD")).toBe("0.05 USD");
    expect(formatMoney(-1, "KWD")).toBe("-0.001 KWD");
    expect(formatMoney(100000000, "KWD")).toBe("100,000.000 KWD");
  });

  test("/unlink calls the service unlink and confirms", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    await run("/unlink");
    expect(finance.callsTo("/channel-identities/unlink")[0]!.body).toEqual({ channel: "telegram", externalUserId: USER });
    expect(finance.identities.size).toBe(0);
    expect(lastReply()).toContain("Disconnected");
    expect(finance.messages).toHaveLength(0);
  });

  test("/forget deletes the agent history and records nothing afterwards", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    await run("hello");
    expect(finance.messages.length).toBeGreaterThan(0);
    await run("/forget");
    expect(finance.historyDeletes).toBe(1);
    expect(finance.messages).toHaveLength(0);
    expect(lastReply()).toContain("history with DALVA was deleted");
  });

  test("plain text: chat is coming soon, with the command list", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    await run("spent 12 on lunch");
    expect(lastReply()).toContain("coming soon");
    expect(lastReply()).toContain("/balance");
  });

  test("unknown command", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    await run("/nope");
    expect(lastReply()).toContain("don't know that command");
  });

  test("photo gets the coming-soon reply", async () => {
    const { finance, runUpdate, lastReply } = setup();
    finance.link(USER);
    await runUpdate(fixture("photo"));
    expect(lastReply()).toContain("coming soon");
  });

  test("records user and bot messages in the current session; /start args are never stored", async () => {
    const { finance, run } = setup();
    finance.link(USER);
    await run("spent 12 on lunch");
    await run("/start");
    expect(finance.callsTo("/agent/sessions/current")[0]!.body).toEqual({
      channel: "telegram",
      chatId: USER,
      idleTimeoutMinutes: 30,
    });
    const stored = finance.messages.map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
    expect(stored[0]).toEqual({ role: "user", content: { kind: "text", text: "spent 12 on lunch" } });
    expect(stored[1]).toMatchObject({ role: "assistant", content: { text: expect.stringContaining("coming soon") } });
    expect(stored[2]).toEqual({ role: "user", content: { kind: "command", command: "start" } });
    expect(new Set(finance.messages.map((m) => m.sessionId)).size).toBe(1);
  });

  test("a full or ended session rolls over to a new one", async () => {
    const { finance, run } = setup();
    finance.link(USER);
    finance.fail("POST /agent/sessions/sess_1/messages", "conflict");
    await run("hi");
    const currents = finance.callsTo("/agent/sessions/current");
    expect(currents[1]!.body).toMatchObject({ startNew: true });
    expect(finance.messages.every((m) => m.sessionId === "sess_2")).toBe(true);
  });

  test("a recording failure doesn't block the reply", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    finance.fail("POST /agent/sessions/current", "internal", 5);
    await run("/help");
    expect(lastReply()).toContain("/balance");
  });
});

describe("finance API errors", () => {
  test.each([
    ["unauthorized", "no longer connected"],
    ["forbidden", "isn't allowed"],
    ["rate_limited", "Too many requests"],
    ["not_found", "isn't available right now"],
    ["conflict", "isn't available right now"],
  ] as const)("%s gets a friendly reply and the event is done", async (code, reply) => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    finance.fail("GET /accounts", code);
    await run("/balance");
    expect(lastReply()).toContain(reply);
    expect([...finance.events.values()].at(-1)).toMatchObject({ status: "done" });
  });

  test("internal errors fail the event and the user is told to retry", async () => {
    const { finance, run, lastReply } = setup();
    finance.link(USER);
    finance.fail("GET /accounts", "internal");
    await run("/balance");
    expect(lastReply()).toContain("Something went wrong");
    expect([...finance.events.values()].at(-1)).toMatchObject({ status: "failed", error: "finance:internal" });
  });

  test("resolve failing (backend down) fails the event", async () => {
    const { finance, run, lastReply } = setup();
    finance.fail("POST /channel-identities/resolve", "network");
    await run("/balance");
    expect(lastReply()).toContain("Something went wrong");
    expect([...finance.events.values()].at(-1)).toMatchObject({ status: "failed", error: "finance:network_error" });
  });
});

describe("chats and buttons", () => {
  test("group commands are answered with 'use a private chat' and never resolved", async () => {
    const { finance, runUpdate, lastReply } = setup();
    finance.link(USER);
    await runUpdate(fixture("group-message"));
    expect(lastReply()).toContain("private chat");
    expect(finance.callsTo("/channel-identities/resolve")).toHaveLength(0);
  });

  test("group plain text is ignored and never stored", async () => {
    const { finance, runUpdate, telegram } = setup();
    await runUpdate(textUpdate(5000, "hello all", 424242, -100123));
    expect(telegram.sent).toHaveLength(0);
    expect(finance.calls).toHaveLength(0);
  });

  test("/start <code> from a group never redeems", async () => {
    const { finance, run } = setup();
    finance.codes.set(CODE, "valid");
    await run(`/start ${CODE}`, 424242, -100123);
    expect(finance.callsTo("/channel-links/redeem")).toHaveLength(0);
  });

  test("button presses are acknowledged only", async () => {
    const { finance, runUpdate, telegram } = setup();
    finance.link(USER);
    await runUpdate(fixture("callback-query"));
    expect(telegram.answered).toEqual([{ id: "4382bfdwdsb323b2d9", text: "This action isn't available yet." }]);
    expect(telegram.sent).toHaveLength(0);
    expect(finance.callsTo("/agent/pending-actions")).toHaveLength(0);
  });
});

describe("userMessageContent", () => {
  const base = { channel: "telegram" as const, eventId: "1", externalUserId: "1", chatId: "1", chatType: "private" as const };

  test("drops /start args (they can hold a link code), keeps other args", () => {
    expect(JSON.parse(userMessageContent({ ...base, kind: "command", command: "start", args: [CODE], text: `/start ${CODE}` }))).toEqual({
      kind: "command",
      command: "start",
    });
    expect(JSON.parse(userMessageContent({ ...base, kind: "command", command: "balance", args: ["x"], text: "/balance x" }))).toEqual({
      kind: "command",
      command: "balance",
      args: ["x"],
    });
  });
});
