import { describe, expect, test } from "vitest";

import { createHandler } from "../src/core/handler";
import { createPipeline } from "../src/core/pipeline";
import { seedFinance } from "./fixtures/finance";
import { captureLogger, fakeFinance, telegramAdapter, type FakeAction } from "./helpers";

const USER = "424242";
const MESSAGE_ID = 77;
const PT_SUMMARY = "Despesa · 5 000,00 AOA · BAI Conta Ordem · hoje";
const EN_SUMMARY = "Expense · 5,000.00 AOA · BAI Conta Ordem · today";

function buttonUpdate(updateId: number, data: string, userId = Number(USER)) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId, is_bot: false, first_name: "Ana" },
      message: { message_id: MESSAGE_ID, date: 1762860020, chat: { id: userId, type: "private" } },
      chat_instance: "1",
      data,
    },
  };
}

function setup(options: { summary?: string; status?: FakeAction["status"]; expired?: boolean; owner?: string } = {}) {
  const { logger, lines } = captureLogger();
  const { adapter, telegram } = telegramAdapter(logger);
  const finance = fakeFinance();
  seedFinance(finance);
  finance.link(USER);
  finance.actions.push({
    id: "action_1",
    sessionId: "sess_1",
    clientKey: "5000:0",
    operation: "transactions.create",
    input: { type: "expense", amount: { amountMinor: 500_000, currency: "AOA" }, accountId: "acc_bai", date: "2026-11-11" },
    summary: options.summary ?? PT_SUMMARY,
    status: options.status ?? "pending",
    expiresAt: new Date(Date.now() + (options.expired ? -1000 : 600_000)).toISOString(),
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
    owner: options.owner ?? USER,
  });
  const { handle, onFailure, accept } = createHandler({ adapter, clients: finance.clients, logger, sessionIdleMinutes: 30, actionRetryDelayMs: 0 });
  let nextId = 9000;
  const press = async (data: string, userId?: number) => {
    const pipeline = createPipeline({ adapter, service: finance.clients.service, handle, onFailure, accept, logger });
    await pipeline.deliver(buttonUpdate(nextId++, data, userId));
    await pipeline.shutdown(5000);
  };
  const action = () => finance.actions.find((a) => a.id === "action_1")!;
  const lastEdit = () => telegram.edited.at(-1);
  const notes = () => finance.messages.map((m) => JSON.parse(m.content).text as string);
  return { finance, telegram, press, action, lastEdit, notes, lines };
}

describe("Confirm", () => {
  test("executes the stored input with the action id as Idempotency-Key, completes, edits the message and answers", async () => {
    const { finance, telegram, press, action, lastEdit, notes } = setup();
    await press("c:action_1");

    expect(finance.writes).toEqual([
      {
        operation: "transactions.create",
        input: { type: "expense", amount: { amountMinor: 500_000, currency: "AOA" }, accountId: "acc_bai", date: "2026-11-11" },
        idempotencyKey: "action_1",
      },
    ]);
    expect(action().status).toBe("executed");
    expect(action().result).toMatchObject({ transaction: { accountId: "acc_bai" } });
    expect(lastEdit()).toEqual({
      chatId: USER,
      messageId: MESSAGE_ID,
      html: `<b>✅ Guardado</b>\n${PT_SUMMARY}`,
      replyMarkup: { inline_keyboard: [] },
    });
    expect(telegram.answered).toEqual([{ id: "cb_9000", text: "✅ Guardado" }]);
    expect(telegram.sent).toHaveLength(0);
    // The model learns the outcome on the next turn.
    expect(notes().at(-1)).toContain("✅ Guardado");
    expect(notes().at(-1)).toContain(PT_SUMMARY);
    expect(finance.events.get("9000")!.status).toBe("done");
  });

  test("English summaries get English texts", async () => {
    const { press, lastEdit } = setup({ summary: EN_SUMMARY });
    await press("c:action_1");
    expect(lastEdit()!.html).toBe(`<b>✅ Saved</b>\n${EN_SUMMARY}`);
  });

  test("a second press doesn't run it twice: it shows it was already saved", async () => {
    const { finance, press, lastEdit, action } = setup();
    await press("c:action_1");
    await press("c:action_1");
    expect(finance.writes).toHaveLength(1);
    expect(action().status).toBe("executed");
    expect(lastEdit()!.html).toBe(`<b>✅ Já guardado</b>\n${PT_SUMMARY}`);
  });

  test("conflict recovery: an action left confirmed by a crash is executed with the same key and completed", async () => {
    const { finance, press, action, lastEdit } = setup({ status: "confirmed" });
    await press("c:action_1");
    expect(finance.callsTo("/agent/pending-actions/action_1/confirm")).toHaveLength(1);
    expect(finance.callsTo("/agent/pending-actions/action_1")).toHaveLength(1); // the get
    expect(finance.writes).toEqual([expect.objectContaining({ idempotencyKey: "action_1" })]);
    expect(action().status).toBe("executed");
    expect(lastEdit()!.html).toContain("✅ Guardado");
  });

  test("after expiry: nothing runs, the message says it expired", async () => {
    const { finance, press, action, lastEdit } = setup({ expired: true });
    await press("c:action_1");
    expect(finance.writes).toHaveLength(0);
    expect(action().status).toBe("expired");
    expect(lastEdit()!.html).toBe(`<b>⌛ Expirou. Pede-me de novo se ainda quiseres.</b>\n${PT_SUMMARY}`);
  });

  test("forbidden (switched to read-only): nothing runs, the user is told, the action stays pending", async () => {
    const { finance, press, action, lastEdit, telegram } = setup();
    finance.identities.get(USER)!.scopes = ["finance:read"];
    await press("c:action_1");
    expect(finance.writes).toHaveLength(0);
    expect(action().status).toBe("pending");
    expect(lastEdit()!.html).toContain("só de leitura");
    expect(telegram.answered).toHaveLength(1);
  });

  test("an ambiguous failure is retried with the same key: the write lands once", async () => {
    const { finance, press, action, lastEdit } = setup();
    finance.fail("POST /transactions", "network_after", 1); // applied, reply lost
    await press("c:action_1");
    const attempts = finance.callsTo("/transactions").filter((c) => c.method === "POST");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((c) => c.idempotencyKey)).toEqual(["action_1", "action_1"]);
    expect(finance.writes).toHaveLength(1);
    expect(action().status).toBe("executed");
    expect(lastEdit()!.html).toContain("✅ Guardado");
  });

  test("still ambiguous after 3 retries: marked failed, the user is told to check before retrying", async () => {
    const { finance, press, action, lastEdit } = setup();
    finance.fail("POST /transactions", "network", 10);
    await press("c:action_1");
    expect(finance.callsTo("/transactions").filter((c) => c.method === "POST")).toHaveLength(4);
    expect(action()).toMatchObject({ status: "failed", result: { error: "network_error", uncertain: true } });
    expect(lastEdit()!.html).toContain("Não consegui confirmar");
  });

  test("a definite failure is not retried: marked failed with the reason", async () => {
    const { finance, press, action, lastEdit } = setup();
    finance.fail("POST /transactions", "validation_failed", 1);
    await press("c:action_1");
    expect(finance.callsTo("/transactions").filter((c) => c.method === "POST")).toHaveLength(1);
    expect(action()).toMatchObject({ status: "failed", result: { error: "validation_failed" } });
    expect(lastEdit()!.html).toMatch(/^<b>❌ Não guardado<\/b>\n/);
  });

  test("an action of another user (forged or replayed payload) is not found: nothing runs", async () => {
    const { finance, press, action, lastEdit } = setup({ owner: "999" });
    await press("c:action_1");
    expect(finance.writes).toHaveLength(0);
    expect(action().status).toBe("pending");
    expect(lastEdit()!.html).toContain("no longer available");
  });

  test("a press from an unlinked chat is only answered", async () => {
    const { finance, press, telegram } = setup();
    await press("c:action_1", 111);
    expect(finance.callsTo("/agent/pending-actions/action_1/confirm")).toHaveLength(0);
    expect(telegram.edited).toHaveLength(0);
    expect(telegram.answered[0]!.text).toMatch(/connected/);
  });

  test("a garbage payload is only answered", async () => {
    const { finance, press, telegram } = setup();
    await press("zz");
    expect(finance.calls.filter((c) => c.path.startsWith("/agent/pending-actions"))).toHaveLength(0);
    expect(telegram.answered).toHaveLength(1);
  });
});

describe("Cancel", () => {
  test("cancels, edits the message and removes the buttons", async () => {
    const { finance, press, action, lastEdit, notes } = setup();
    await press("x:action_1");
    expect(action().status).toBe("cancelled");
    expect(finance.writes).toHaveLength(0);
    expect(lastEdit()).toMatchObject({ html: `<b>Cancelado</b>\n${PT_SUMMARY}`, replyMarkup: { inline_keyboard: [] } });
    expect(notes().at(-1)).toContain("Cancelado");
  });

  test("Cancel after Confirm shows the saved state; Confirm after Cancel runs nothing", async () => {
    const saved = setup();
    await saved.press("c:action_1");
    await saved.press("x:action_1");
    expect(saved.lastEdit()!.html).toContain("Já guardado");
    const cancelled = setup();
    await cancelled.press("x:action_1");
    await cancelled.press("c:action_1");
    expect(cancelled.finance.writes).toHaveLength(0);
    expect(cancelled.lastEdit()!.html).toContain("Cancelado");
  });
});
