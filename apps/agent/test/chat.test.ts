import { describe, expect, test } from "vitest";

import { createAgent } from "../src/core/agent";
import { createHandler } from "../src/core/handler";
import { createPipeline } from "../src/core/pipeline";
import { createRateLimiter } from "../src/core/rate-limit";
import { seedFinance } from "./fixtures/finance";
import { captureLogger, fakeFinance, fixture, telegramAdapter, textUpdate, waitFor } from "./helpers";
import { scriptedModel, type MockStep } from "./mock-model";

const USER = "424242";

function setup(steps: MockStep[], limits: { turns?: number; maxChars?: number; stopSignal?: AbortSignal } = {}) {
  const { logger, lines } = captureLogger();
  const { adapter, telegram } = telegramAdapter(logger);
  const finance = fakeFinance();
  seedFinance(finance);
  finance.link(USER, { displayName: "Ana" });
  const model = scriptedModel(steps);
  let clock = 0;
  const agent = createAgent({ model, maxSteps: 4, turnTimeoutMs: 5_000, timezone: "Africa/Luanda", logger, stopSignal: limits.stopSignal });
  const limiter = createRateLimiter({ limit: limits.turns ?? 20, windowMs: 10 * 60_000, now: () => clock });
  const { handle, onFailure, accept } = createHandler({
    adapter,
    clients: finance.clients,
    logger,
    sessionIdleMinutes: 30,
    chat: { agent, limiter, maxChars: limits.maxChars ?? 2000 },
  });
  let nextId = 5000;
  const run = async (text: string) => {
    const p = createPipeline({ adapter, service: finance.clients.service, handle, onFailure, accept, logger });
    await p.deliver(textUpdate(nextId++, text));
    await p.shutdown(5000);
  };
  const runUpdate = async (update: unknown) => {
    const p = createPipeline({ adapter, service: finance.clients.service, handle, onFailure, accept, logger });
    await p.deliver(update);
    await p.shutdown(5000);
  };
  const lastReply = () => telegram.sent[telegram.sent.length - 1]?.html ?? "";
  return { finance, telegram, model, run, runUpdate, lastReply, lines, handle, adapter, advance: (ms: number) => (clock += ms) };
}

describe("chat", () => {
  test("plain text goes to the agent and the reply is sent, escaped", async () => {
    const { run, lastReply, model, telegram, finance } = setup([
      { tools: [{ name: "get_spending_by_category", input: {} }] },
      { text: "Gastaste 42 450,00 AOA em Alimentação <este mês>." },
    ]);
    await run("quanto gastei em comida este mês?");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(lastReply()).toBe("Gastaste 42 450,00 AOA em Alimentação &lt;este mês&gt;.");
    expect(telegram.actions.some((a) => a.action === "typing")).toBe(true);
    expect(finance.events.get("5000")!.status).toBe("done");
  });

  test("the reply goes out before the turn is stored; a store stalled at shutdown is aborted and the event still completes", async () => {
    const stop = new AbortController();
    const { run, lastReply, finance, lines } = setup([{ text: "Tens 845 320,50 AOA." }], { stopSignal: stop.signal });
    const release = finance.hold("POST /agent/sessions/sess_1/messages");
    const pending = run("saldo?");
    await waitFor(() => lastReply() === "Tens 845 320,50 AOA.");
    expect(finance.messages).toHaveLength(0);
    stop.abort(new Error("shutdown"));
    await pending;
    release();
    expect(finance.events.get("5000")!.status).toBe("done");
    expect(finance.messages).toHaveLength(0);
    expect(lines.some((line) => line.includes('"msg":"session_record_failed"'))).toBe(true);
    expect(lines.some((line) => line.includes('"msg":"event_failed"'))).toBe(false);
  });

  test("commands keep working without the model", async () => {
    const { run, lastReply, model } = setup([{ text: "never" }]);
    await run("/balance");
    expect(lastReply()).toContain("BAI Conta Ordem");
    await run("/help");
    expect(lastReply()).toContain("/balance");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("messages over the cap get a friendly reply and never reach the model", async () => {
    const { run, lastReply, model, finance } = setup([{ text: "never" }], { maxChars: 50 });
    await run("x".repeat(51));
    expect(lastReply()).toMatch(/too long/i);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(finance.messages).toHaveLength(0);
  });

  test("per-user rate limit, with a friendly reply, that frees up after the window", async () => {
    const { run, lastReply, model, advance } = setup([{ text: "ok" }], { turns: 2 });
    await run("one");
    await run("two");
    await run("three");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(lastReply()).toMatch(/a lot of messages/i);
    advance(10 * 60_000 + 1);
    await run("four");
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(lastReply()).toBe("ok");
  });

  test("a model error gets the apology and the event is failed", async () => {
    const { run, lastReply, finance } = setup([{ error: new Error("provider exploded") }]);
    await run("olá");
    expect(lastReply()).toContain("Something went wrong");
    expect(finance.events.get("5000")!.status).toBe("failed");
  });

  test("a revoked link mid-turn gets the relink message", async () => {
    const { run, lastReply, finance } = setup([{ tools: [{ name: "list_accounts", input: {} }] }, { text: "never" }]);
    finance.fail("GET /accounts", "unauthorized");
    await run("saldo?");
    expect(lastReply()).toContain("no longer connected");
  });

  test("a forbidden or rate-limited Finance API inside a tool gets the command replies", async () => {
    for (const [code, reply] of [
      ["forbidden", "isn't allowed"],
      ["rate_limited", "Too many requests"],
    ] as const) {
      const { run, lastReply, finance } = setup([{ tools: [{ name: "get_net_worth", input: {} }] }, { text: "never" }]);
      finance.fail("GET /reports/net-worth", code);
      await run("net worth?");
      expect(lastReply()).toContain(reply);
      expect(finance.messages).toHaveLength(0);
    }
  });

  test("photos get a not-supported-yet reply", async () => {
    const { runUpdate, lastReply, model, finance } = setup([{ text: "never" }]);
    const photo = fixture("photo");
    finance.link(String(photo.message.from.id));
    await runUpdate(photo);
    expect(lastReply()).toMatch(/can.t read photos yet/i);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("an unlinked chat never reaches the model", async () => {
    const { run, lastReply, model, finance } = setup([{ text: "never" }]);
    finance.identities.clear();
    await run("olá");
    expect(lastReply()).toContain("isn't connected");
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe("rate limiter", () => {
  test("sliding window per key", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    now = 600;
    expect(limiter.take("a")).toBe(false);
    now = 1001;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  test("forgets idle keys", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    for (let i = 0; i < 100; i++) limiter.take(`k${i}`);
    now = 5000;
    limiter.take("x");
    expect(limiter.size).toBeLessThanOrEqual(1);
  });
});

describe("chat: proposing a change", () => {
  const create = { type: "expense", amount: "5000", accountId: "acc_bai", categoryId: "cat_food", subcategoryId: "sub_rest", language: "pt" };
  const summary = "Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje";

  test("the turn ends with a Confirm/Cancel message; pressing Confirm saves it and edits that message", async () => {
    const { run, runUpdate, telegram, finance } = setup([
      { tools: [{ name: "create_transaction", input: create }] },
      { text: "Confirma abaixo para guardar." },
    ]);
    await run("gastei 5000 kz no almoço hoje");
    const confirm = telegram.sent.at(-1)!;
    expect(confirm.html).toBe(`Confirma abaixo para guardar.\n\n<b>${summary}</b>`);
    const buttons = (confirm.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(["c:action_1", "x:action_1"]);
    expect(finance.writes).toHaveLength(0);

    await runUpdate({
      update_id: 6000,
      callback_query: {
        id: "cb1",
        from: { id: Number(USER), is_bot: false, first_name: "Ana" },
        message: { message_id: telegram.sent.length, date: 1, chat: { id: Number(USER), type: "private" } },
        chat_instance: "1",
        data: "c:action_1",
      },
    });
    expect(finance.writes).toEqual([expect.objectContaining({ operation: "transactions.create", idempotencyKey: "action_1" })]);
    expect(telegram.edited.at(-1)).toMatchObject({ messageId: telegram.sent.length, html: `<b>✅ Guardado</b>\n${summary}` });
  });

  test("a replayed turn whose change was already saved shows that, without buttons", async () => {
    const proposal = { tools: [{ name: "create_transaction", input: create }] };
    const { telegram, finance, handle, adapter } = setup([proposal, { text: "Confirma." }, proposal, { text: "Pronto." }]);
    const event = adapter.parse(textUpdate(7000, "gastei 5000 no almoço"))!;
    await handle(event);
    expect(telegram.sent.at(-1)!.replyMarkup).toBeDefined();
    finance.actions[0]!.status = "executed";
    await handle(event); // boot recovery replays the same event
    expect(finance.actions).toHaveLength(1);
    expect(telegram.sent.at(-1)!.replyMarkup).toBeUndefined();
    expect(telegram.sent.at(-1)!.html).toBe(`Pronto.\n\n<b>✅ Já guardado</b>\n${summary}`);
  });
});

