import { describe, expect, test } from "vitest";

import { createTools, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/tools";
import { Proposals } from "../src/tools/proposals";
import { seedFinance } from "./fixtures/finance";
import { fakeFinance } from "./helpers";

const USER = "424242";
const TODAY = "2026-11-11";

function setup(options: { eventId?: string; finance?: ReturnType<typeof fakeFinance> } = {}) {
  const finance = options.finance ?? fakeFinance();
  if (!options.finance) {
    seedFinance(finance);
    finance.accounts.push(
      { id: "acc_jpy", name: "Tokyo Cash", type: "cash", balance: { amountMinor: 50_000, currency: "JPY" } },
      { id: "acc_kwd", name: "Kuwait Bank", type: "bank", balance: { amountMinor: 1_000_000, currency: "KWD" } },
    );
    finance.link(USER);
    finance.sessions.push({ id: "sess_1", channel: "telegram", chatId: USER, startedAt: "x", lastActivityAt: "x", messageCount: 0 });
  }
  const client = finance.clients.forToken(`tok_${USER}`);
  const fatal: unknown[] = [];
  const proposals = new Proposals({ finance: client, eventId: options.eventId ?? "5001", sessionId: async () => "sess_1" });
  const tools = createTools({ finance: client, today: TODAY, onFatal: (error) => fatal.push(error) }, { proposals });
  const run = async (name: string, input: Record<string, unknown>) => {
    const tool = (tools as Record<string, unknown>)[name] as { execute: (input: unknown, options: unknown) => Promise<any> };
    return tool.execute(input, { toolCallId: "t1", messages: [] });
  };
  return { finance, tools, run, proposals, fatal };
}

const expense = (extra: Record<string, unknown> = {}) => ({
  type: "expense",
  amount: "5000",
  accountId: "acc_bai",
  categoryId: "cat_food",
  subcategoryId: "sub_rest",
  language: "pt",
  ...extra,
});

describe("tool sets", () => {
  test("write tools are only offered with a write context", () => {
    const finance = fakeFinance();
    const context = { finance: finance.clients.forToken("t"), today: TODAY, onFatal: () => {} };
    expect(Object.keys(createTools(context)).sort()).toEqual([...READ_TOOL_NAMES].sort());
    const proposals = new Proposals({ finance: context.finance, eventId: "1", sessionId: async () => "s" });
    expect(Object.keys(createTools(context, { proposals })).sort()).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(
      [
        "add_goal_contribution",
        "create_transaction",
        "create_transfer",
        "delete_transaction",
        "delete_transfer",
        "record_debt_payment",
        "update_transaction",
      ].sort(),
    );
  });

  test("no write tool takes a user id, token or session", () => {
    const { tools } = setup();
    for (const name of WRITE_TOOL_NAMES) {
      const schema = (tools as any)[name].inputSchema;
      const keys = Object.keys(schema.shape ?? schema.jsonSchema?.properties ?? {});
      expect(keys.join(","), name).not.toMatch(/user|token|auth|session|clientKey/i);
    }
  });
});

describe("create_transaction", () => {
  test("proposes: converts the amount, validates, creates the action with a clientKey, returns the summary", async () => {
    const { run, finance, proposals } = setup();
    const result = await run("create_transaction", expense());
    const summary = "Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje";
    expect(result).toEqual({ status: "awaiting_confirmation", summary });
    expect(finance.actions).toHaveLength(1);
    expect(finance.actions[0]).toMatchObject({
      sessionId: "sess_1",
      clientKey: "5001:0",
      operation: "transactions.create",
      status: "pending",
      summary,
      input: {
        type: "expense",
        amount: { amountMinor: 500_000, currency: "AOA" },
        accountId: "acc_bai",
        categoryId: "cat_food",
        subcategoryId: "sub_rest",
        date: TODAY,
      },
    });
    expect(proposals.current?.action.id).toBe("action_1");
    expect(finance.writes).toHaveLength(0); // never the write route itself
  });

  test("amounts: 0-, 2- and 3-decimal currencies", async () => {
    const jpy = setup();
    expect(await jpy.run("create_transaction", { type: "expense", amount: "1500", accountId: "acc_jpy", language: "en" })).toMatchObject({
      summary: "Expense · 1,500 JPY · Tokyo Cash · today",
    });
    expect(jpy.finance.actions[0]!.input.amount).toEqual({ amountMinor: 1500, currency: "JPY" });

    const usd = setup();
    await usd.run("create_transaction", { type: "income", amount: "1240.5", accountId: "acc_usd", categoryId: "cat_freelance", language: "en", date: "2026-11-10" });
    expect(usd.finance.actions[0]!.input.amount).toEqual({ amountMinor: 124_050, currency: "USD" });
    expect(usd.finance.actions[0]!.summary).toBe("Income · 1,240.50 USD · Freelance · Wise USD · yesterday");

    const kwd = setup();
    await kwd.run("create_transaction", { type: "expense", amount: "12.345", accountId: "acc_kwd", language: "pt", date: "2026-10-01" });
    expect(kwd.finance.actions[0]!.input.amount).toEqual({ amountMinor: 12_345, currency: "KWD" });
    expect(kwd.finance.actions[0]!.summary).toBe("Despesa · 12,345 KWD · Kuwait Bank · 01/10/2026");
  });

  test("bad input fails at proposal time and creates nothing", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ amount: "abc" }, /amount/i],
      [{ amount: "0" }, /greater than zero/i],
      [{ amount: "-5" }, /amount/i],
      [{ amount: "5000.123" }, /2 decimal/],
      [{ amount: "1,5" }, /amount/i],
      [{ accountId: "acc_jpy", subcategoryId: undefined, categoryId: undefined, amount: "1.5" }, /0 decimal/],
      [{ currency: "USD" }, /AOA/],
      [{ categoryId: "cat_salary", subcategoryId: undefined }, /income category/i],
      [{ subcategoryId: "sub_fuel" }, /subcategory/i],
      [{ accountId: "acc_old" }, /archived/i],
      [{ date: "2026-02-30" }, /date/i],
    ];
    for (const [patch, message] of cases) {
      const { run, finance } = setup();
      const result = await run("create_transaction", expense(patch));
      expect(result, JSON.stringify(patch)).toMatchObject({ error: expect.any(String), message: expect.stringMatching(message) });
      expect(finance.actions, JSON.stringify(patch)).toHaveLength(0);
    }
    const missing = setup();
    expect(await missing.run("create_transaction", expense({ accountId: "acc_nope" }))).toMatchObject({ error: "not_found" });
  });

  test("trailing zeros past the currency's decimals are fine; an out-of-range amount is invalid input", async () => {
    const jpy = setup();
    await jpy.run("create_transaction", { type: "expense", amount: "1500.00", accountId: "acc_jpy", language: "en" });
    expect(jpy.finance.actions[0]!.input.amount).toEqual({ amountMinor: 1500, currency: "JPY" });
    const huge = setup();
    expect(await huge.run("create_transaction", expense({ amount: "999999999999999999999" }))).toMatchObject({ error: "invalid_input" });
    expect(huge.finance.actions).toHaveLength(0);
  });

  test("a subcategory alone implies its category", async () => {
    const { run, finance } = setup();
    await run("create_transaction", expense({ categoryId: undefined, subcategoryId: "sub_taxi", language: "en" }));
    expect(finance.actions[0]!.input).toMatchObject({ categoryId: "cat_transport", subcategoryId: "sub_taxi" });
    expect(finance.actions[0]!.summary).toBe("Expense · 5,000.00 AOA · Transporte › Táxi / Yango · BAI Conta Ordem · today");
  });

  test("description and payee go into the input and the summary", async () => {
    const { run, finance } = setup();
    await run("create_transaction", expense({ description: "Almoço com a equipa", payee: "Café Ilha" }));
    expect(finance.actions[0]!.input).toMatchObject({ description: "Almoço com a equipa", payee: "Café Ilha" });
    expect(finance.actions[0]!.summary).toBe(
      "Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje · Café Ilha · “Almoço com a equipa”",
    );
  });
});

describe("one action per turn and idempotent creation", () => {
  test("a second proposal in the same turn is refused, also when both run at once", async () => {
    const { run, finance } = setup();
    const [a, b] = await Promise.all([run("create_transaction", expense()), run("create_transaction", expense({ amount: "10" }))]);
    expect([a, b].filter((r) => r.status === "awaiting_confirmation")).toHaveLength(1);
    expect([a, b].find((r) => r.error)).toMatchObject({ error: "one_at_a_time" });
    expect(await run("create_transfer", { amount: "1", fromAccountId: "acc_bai", toAccountId: "acc_poup", language: "pt" })).toMatchObject({
      error: "one_at_a_time",
    });
    expect(finance.actions).toHaveLength(1);
  });

  test("a failed proposal doesn't use up the turn's slot", async () => {
    const { run, finance } = setup();
    expect(await run("create_transaction", expense({ amount: "x" }))).toMatchObject({ error: "invalid_input" });
    expect(await run("create_transaction", expense())).toMatchObject({ status: "awaiting_confirmation" });
    expect(finance.actions).toHaveLength(1);
    expect(finance.actions[0]!.clientKey).toBe("5001:0");
  });

  test("replaying the same event returns the existing action, with its current status", async () => {
    const first = setup({ eventId: "7001" });
    await first.run("create_transaction", expense());
    const replay = setup({ eventId: "7001", finance: first.finance });
    expect(await replay.run("create_transaction", expense({ amount: "6000" }))).toEqual({
      status: "awaiting_confirmation",
      summary: first.finance.actions[0]!.summary,
    });
    first.finance.actions[0]!.status = "executed";
    const again = setup({ eventId: "7001", finance: first.finance });
    expect(await again.run("create_transaction", expense())).toMatchObject({ status: "already_executed" });
    expect(again.proposals.current?.action.status).toBe("executed");
    expect(first.finance.actions).toHaveLength(1);
  });

  test("refusals from the API end the turn (read-only switched on mid-turn)", async () => {
    const { run, finance, fatal } = setup();
    finance.identities.get(USER)!.scopes = ["finance:read"];
    expect(await run("create_transaction", expense())).toMatchObject({ error: "forbidden" });
    expect(fatal).toHaveLength(1);
    expect(finance.actions).toHaveLength(0);
  });
});

describe("update_transaction and delete_transaction", () => {
  test("update proposes only the changed fields, described against the current row", async () => {
    const { run, finance } = setup();
    const result = await run("update_transaction", { id: "tx_1", amount: "20000", date: "2026-11-11", language: "pt" });
    expect(finance.actions[0]).toMatchObject({
      operation: "transactions.update",
      input: { id: "tx_1", amount: { amountMinor: 2_000_000, currency: "AOA" }, date: TODAY },
    });
    expect(result.summary).toBe(
      "Editar despesa · 18 450,00 AOA · Alimentação › Supermercado · BAI Conta Ordem · ontem · “Kero Talatona” → valor: 20 000,00 AOA, data: hoje",
    );
  });

  test("update in English, moving to another category", async () => {
    const { run } = setup();
    const result = await run("update_transaction", { id: "tx_2", categoryId: "cat_fun", language: "en" });
    expect(result.summary).toBe("Edit expense · 6,500.00 AOA · Transporte › Táxi / Yango · Carteira · Nov 9, 2026 · “Yango” → category: Lazer");
  });

  test("update refuses no-op, managed rows and a cross-currency move without an amount", async () => {
    const { run, finance } = setup();
    expect(await run("update_transaction", { id: "tx_1", language: "en" })).toMatchObject({ error: "invalid_input" });
    expect(await run("update_transaction", { id: "tx_tr_out", amount: "1", language: "en" })).toMatchObject({
      error: "managed",
      message: expect.stringMatching(/delete_transfer/),
    });
    expect(await run("update_transaction", { id: "tx_debt", amount: "1", language: "en" })).toMatchObject({ error: "managed" });
    expect(await run("update_transaction", { id: "tx_1", accountId: "acc_usd", language: "en" })).toMatchObject({
      message: expect.stringMatching(/amount/),
    });
    expect(await run("update_transaction", { id: "tx_1", type: "income", language: "en" })).toMatchObject({
      message: expect.stringMatching(/category/),
    });
    expect(finance.actions).toHaveLength(0);
  });

  test("delete describes the row being deleted", async () => {
    const { run, finance } = setup();
    const result = await run("delete_transaction", { id: "tx_1", language: "pt" });
    expect(finance.actions[0]).toMatchObject({ operation: "transactions.delete", input: { id: "tx_1" } });
    expect(result.summary).toBe("Apagar despesa · 18 450,00 AOA · Alimentação › Supermercado · BAI Conta Ordem · ontem · “Kero Talatona”");
    const managed = setup();
    expect(await managed.run("delete_transaction", { id: "tx_tr_in", language: "en" })).toMatchObject({ error: "managed" });
    expect(await managed.run("delete_transaction", { id: "tx_missing", language: "en" })).toMatchObject({ error: "not_found" });
  });
});

describe("transfers", () => {
  test("create: same currency only, different accounts", async () => {
    const { run, finance } = setup();
    expect(await run("create_transfer", { amount: "20000", fromAccountId: "acc_bai", toAccountId: "acc_usd", language: "pt" })).toMatchObject({
      message: expect.stringMatching(/currenc/i),
    });
    expect(await run("create_transfer", { amount: "20000", fromAccountId: "acc_bai", toAccountId: "acc_bai", language: "pt" })).toMatchObject({
      error: "invalid_input",
    });
    const result = await run("create_transfer", { amount: "20000", fromAccountId: "acc_bai", toAccountId: "acc_poup", language: "pt" });
    expect(result.summary).toBe("Transferência · 20 000,00 AOA · BAI Conta Ordem → Poupança BFA · hoje");
    expect(finance.actions[0]).toMatchObject({
      operation: "transfers.create",
      input: { amount: { amountMinor: 2_000_000, currency: "AOA" }, fromAccountId: "acc_bai", toAccountId: "acc_poup", date: TODAY },
    });
  });

  test("delete from either leg names both accounts; goal-contribution transfers are refused", async () => {
    const { run, finance } = setup();
    const result = await run("delete_transfer", { id: "tx_tr_in", language: "en" });
    expect(result.summary).toBe("Delete transfer · 20,000.00 AOA · BAI Conta Ordem → Poupança BFA · Nov 7, 2026");
    expect(finance.actions[0]).toMatchObject({ operation: "transfers.delete", input: { id: "tx_tr_in" } });
    const other = setup();
    expect(await other.run("delete_transfer", { id: "tx_goal", language: "en" })).toMatchObject({ error: "managed" });
    expect(await other.run("delete_transfer", { id: "tx_1", language: "en" })).toMatchObject({ error: "invalid_input" });
  });
});

describe("goal contributions and debt payments", () => {
  test("a linked goal needs the source account; the summary names goal and account", async () => {
    const { run, finance } = setup();
    expect(await run("add_goal_contribution", { goalId: "goal_car", amount: "50000", language: "pt" })).toMatchObject({
      message: expect.stringMatching(/account/),
    });
    const result = await run("add_goal_contribution", { goalId: "goal_car", amount: "50000", fromAccountId: "acc_bai", language: "pt" });
    expect(result.summary).toBe("Contribuição para meta · 50 000,00 AOA · Carro · de BAI Conta Ordem · hoje");
    expect(finance.actions[0]).toMatchObject({
      operation: "goalContributions.add",
      input: { goalId: "goal_car", amount: { amountMinor: 5_000_000, currency: "AOA" }, fromAccountId: "acc_bai", date: TODAY },
    });
  });

  test("a virtual goal takes no account", async () => {
    const { run, finance } = setup();
    const result = await run("add_goal_contribution", { goalId: "goal_trip", amount: "10000", language: "en" });
    expect(result.summary).toBe("Goal contribution · 10,000.00 AOA · Viagem a Lisboa · today");
    expect(finance.actions[0]!.input).not.toHaveProperty("fromAccountId");
  });

  test("debt payment with interest splits principal and interest", async () => {
    const { run, finance } = setup();
    const result = await run("record_debt_payment", { debtId: "debt_car", amount: "95000", interest: "5000", fromAccountId: "acc_bai", language: "en" });
    expect(finance.actions[0]).toMatchObject({
      operation: "debtPayments.record",
      input: {
        debtId: "debt_car",
        amount: { amountMinor: 9_500_000, currency: "AOA" },
        principalAmount: { amountMinor: 9_000_000, currency: "AOA" },
        interestAmount: { amountMinor: 500_000, currency: "AOA" },
        fromAccountId: "acc_bai",
        date: TODAY,
      },
    });
    expect(result.summary).toBe("Debt payment · 95,000.00 AOA · Crédito automóvel · from BAI Conta Ordem · today · interest 5,000.00 AOA");
    const bad = setup();
    expect(await bad.run("record_debt_payment", { debtId: "debt_car", amount: "100", interest: "200", fromAccountId: "acc_bai", language: "en" })).toMatchObject({
      error: "invalid_input",
    });
    expect(await bad.run("record_debt_payment", { debtId: "debt_car", amount: "100", fromAccountId: "acc_usd", language: "en" })).toMatchObject({
      message: expect.stringMatching(/AOA/),
    });
  });
});
