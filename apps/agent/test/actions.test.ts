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
    input: { type: "expense", amount: { amountMinor: 500_000, currency: "AOA" }, accountId: "00000001-0000-4000-8000-000000000001", date: "2026-11-11" },
    summary: options.summary ?? PT_SUMMARY,
    status: options.status ?? "pending",
    expiresAt: new Date(Date.now() + (options.expired ? -1000 : 600_000)).toISOString(),
    // Relative to now: a confirmed action older than the 6-day rerun window is never re-run.
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
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
        input: { type: "expense", amount: { amountMinor: 500_000, currency: "AOA" }, accountId: "00000001-0000-4000-8000-000000000001", date: "2026-11-11" },
        idempotencyKey: "action_1",
      },
    ]);
    expect(action().status).toBe("executed");
    expect(action().result).toMatchObject({ transaction: { accountId: "00000001-0000-4000-8000-000000000001" } });
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

  test("runs an account adjustment through /api/trpc, still keyed by the action id", async () => {
    const { finance, press, action } = setup();
    Object.assign(action(), { operation: "accounts.adjust", input: { id: "00000001-0000-4000-8000-000000000001", amount: { amountMinor: -1_000, currency: "AOA" } } });
    await press("c:action_1");
    expect(finance.calls.find((c) => c.path === "/accounts/00000001-0000-4000-8000-000000000001/adjustments")).toMatchObject({ method: "POST", idempotencyKey: "action_1" });
    expect(finance.writes).toEqual([
      { operation: "accounts.adjust", input: { id: "00000001-0000-4000-8000-000000000001", amount: { amountMinor: -1_000, currency: "AOA" } }, idempotencyKey: "action_1" },
    ]);
    expect(action().status).toBe("executed");
    expect(action().result).toMatchObject({ account: { id: "00000001-0000-4000-8000-000000000001" } });
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
    expect(lastEdit()!.html).toContain("Pode ter sido guardado. Verifica no DALVA antes de tentar de novo.");
  });

  test("an ambiguous attempt followed by a refusal is still reported as uncertain, not 'not saved'", async () => {
    const { finance, press, action, lastEdit } = setup();
    // Attempt 1 may have landed (reply lost); attempt 2 is refused (e.g. switched to read-only in between).
    finance.failSequence("POST /transactions", ["network_after", "forbidden"]);
    await press("c:action_1");
    expect(finance.callsTo("/transactions").filter((c) => c.method === "POST")).toHaveLength(2);
    expect(action()).toMatchObject({ status: "failed", result: { uncertain: true } });
    expect(lastEdit()!.html).toContain("Pode ter sido guardado. Verifica no DALVA antes de tentar de novo.");
  });

  test("a confirmed action older than the idempotency window is not run again", async () => {
    const { finance, press, action, lastEdit } = setup({ status: "confirmed" });
    action().updatedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await press("c:action_1");
    expect(finance.writes).toHaveLength(0);
    expect(action()).toMatchObject({ status: "failed", result: { uncertain: true } });
    expect(lastEdit()!.html).toContain("Pode ter sido guardado. Verifica no DALVA antes de tentar de novo.");
  });

  test("a later press on an action that failed uncertainly keeps the warning", async () => {
    const { finance, press, lastEdit } = setup();
    finance.fail("POST /transactions", "network", 10);
    await press("c:action_1");
    await press("c:action_1");
    expect(lastEdit()!.html).toBe(`<b>⚠️ Pode ter sido guardado. Verifica no DALVA antes de tentar de novo.</b>\n${PT_SUMMARY}`);
    expect(lastEdit()!.html).not.toContain("falhou");
  });

  test("a definite failure shown again later still says it failed", async () => {
    const { finance, press, lastEdit } = setup();
    finance.fail("POST /transactions", "validation_failed", 1);
    await press("c:action_1");
    await press("c:action_1");
    expect(lastEdit()!.html).toContain("❌ Esta alteração falhou");
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

describe("Confirm on a batch (several changes from one message)", () => {
  const BATCH_SUMMARY = [
    "1. Despesa · 3 000,00 AOA · BAI Conta Ordem · hoje",
    "2. Transferência · 20 000,00 AOA · BAI Conta Ordem → Poupança BFA · hoje",
    "3. Receita · 300 000,00 AOA · BAI Conta Ordem · hoje",
  ].join("\n");
  const account = "00000001-0000-4000-8000-000000000001";
  const items = [
    { operation: "transactions.create", input: { type: "expense", amount: { amountMinor: 300_000, currency: "AOA" }, accountId: account, date: "2026-11-11" } },
    { operation: "transfers.create", input: { amount: { amountMinor: 2_000_000, currency: "AOA" }, fromAccountId: account, toAccountId: "00000001-0000-4000-8000-000000000002", date: "2026-11-11" } },
    { operation: "transactions.create", input: { type: "income", amount: { amountMinor: 30_000_000, currency: "AOA" }, accountId: account, date: "2026-11-11" } },
  ];
  const batch = (options: Parameters<typeof setup>[0] = {}) => {
    const context = setup({ summary: BATCH_SUMMARY, ...options });
    Object.assign(context.action(), { operation: "batch", input: { items } });
    return context;
  };

  test("runs every item in order, item i keyed <action id>:<i>, and shows them all saved", async () => {
    const { finance, telegram, press, action, lastEdit } = batch();
    await press("c:action_1");
    expect(finance.writes.map((w) => [w.operation, w.idempotencyKey])).toEqual([
      ["transactions.create", "action_1:0"],
      ["transfers.create", "action_1:1"],
      ["transactions.create", "action_1:2"],
    ]);
    expect(action()).toMatchObject({ status: "executed", result: { items: [{ status: "executed" }, { status: "executed" }, { status: "executed" }] } });
    expect(lastEdit()!.html).toBe(`<b>✅ Guardado</b>\n${BATCH_SUMMARY.split("\n").map((line) => `✅ ${line}`).join("\n")}`);
    expect(telegram.answered).toEqual([{ id: "cb_9000", text: "✅ Guardado" }]);
  });

  test("one item failing doesn't stop the others; the message says which one wasn't saved and why", async () => {
    const { finance, press, action, lastEdit } = batch();
    finance.fail("POST /transfers", "validation_failed", 1);
    await press("c:action_1");
    expect(finance.writes.map((w) => w.idempotencyKey)).toEqual(["action_1:0", "action_1:2"]);
    expect(action()).toMatchObject({
      status: "failed",
      result: { error: "partial", items: [{ status: "executed" }, { status: "failed", error: "validation_failed" }, { status: "executed" }] },
    });
    const html = lastEdit()!.html;
    expect(html.startsWith("<b>⚠️ Guardado em parte</b>")).toBe(true);
    expect(html).toContain("✅ 1. Despesa");
    expect(html).toContain("❌ 2. Transferência · 20 000,00 AOA · BAI Conta Ordem → Poupança BFA · hoje (Os dados já não são válidos");
    expect(html).toContain("✅ 3. Receita");
    // A later press shows the same per-item result.
    await press("c:action_1");
    expect(lastEdit()!.html).toBe(html);
  });

  test("a rerun after a crash replays the items that already ran (same keys) and runs the rest", async () => {
    const { finance, press, action } = batch({ status: "confirmed" });
    // The crash happened after item 0 ran.
    await finance.clients.forToken(`tok_${USER}`).transactions.create.mutate(items[0]!.input as never, { context: { idempotencyKey: "action_1:0" } });
    await press("c:action_1");
    expect(finance.writes.map((w) => w.idempotencyKey)).toEqual(["action_1:0", "action_1:1", "action_1:2"]);
    expect(action().status).toBe("executed");
  });

  test("Cancel cancels the whole batch", async () => {
    const { finance, press, action, lastEdit } = batch();
    await press("x:action_1");
    expect(action().status).toBe("cancelled");
    expect(finance.writes).toHaveLength(0);
    expect(lastEdit()!.html).toBe(`<b>Cancelado</b>\n${BATCH_SUMMARY}`);
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
