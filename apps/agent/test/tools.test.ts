import { describe, expect, test } from "vitest";

import { createReadTools, READ_TOOL_NAMES, type ReadTools } from "../src/tools";
import { seedFinance } from "./fixtures/finance";
import { fakeFinance } from "./helpers";

const USER = "424242";

function setup() {
  const finance = fakeFinance();
  seedFinance(finance);
  finance.link(USER);
  const fatal: unknown[] = [];
  const tools = createReadTools({
    finance: finance.clients.forToken(`tok_${USER}`),
    today: "2026-11-11",
    onFatal: (error) => fatal.push(error),
  });
  const run = async (name: keyof ReadTools, input: Record<string, unknown> = {}) => {
    const tool = tools[name] as unknown as { execute: (input: unknown, options: unknown) => Promise<any> };
    return tool.execute(input, { toolCallId: "t1", messages: [] });
  };
  return { finance, tools, run, fatal };
}

describe("read tools", () => {
  test("exposes exactly the read-only tool set", () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual([...READ_TOOL_NAMES].sort());
    expect(READ_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "list_accounts",
        "list_categories",
        "search_transactions",
        "get_transaction_summary",
        "get_spending_by_category",
        "get_cashflow",
        "get_net_worth",
        "list_goals",
        "list_debts",
      ]),
    );
  });

  test("list_accounts: compact, decimal amounts, archived hidden by default", async () => {
    const { run } = setup();
    const result = await run("list_accounts");
    expect(result.accounts[0]).toEqual({ id: "acc_bai", name: "BAI Conta Ordem", type: "bank", balance: { amount: "845320.50", currency: "AOA" } });
    expect(result.accounts.find((a: any) => a.id === "acc_old")).toBeUndefined();
    expect(result.accounts.find((a: any) => a.id === "acc_usd").balance).toEqual({ amount: "1240.75", currency: "USD" });
  });

  test("list_categories nests subcategories", async () => {
    const { run } = setup();
    const result = await run("list_categories", { type: "expense" });
    const food = result.categories.find((c: any) => c.id === "cat_food");
    expect(food).toEqual({
      id: "cat_food",
      name: "Alimentação",
      type: "expense",
      subcategories: [
        { id: "sub_market", name: "Supermercado" },
        { id: "sub_rest", name: "Restaurantes" },
      ],
    });
    expect(result.categories.every((c: any) => c.type === "expense")).toBe(true);
  });

  test("search_transactions maps filters, caps the limit at 20, and adds names", async () => {
    const { run, finance } = setup();
    const result = await run("search_transactions", { type: "expense", dateFrom: "2026-11-01", dateTo: "2026-11-30", text: "yango" });
    expect(finance.callsTo("/transactions")[0]!.body).toMatchObject({
      type: "expense",
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
      q: "yango",
      limit: "10",
    });
    expect(result.transactions).toEqual([
      {
        id: "tx_2",
        date: "2026-11-09",
        type: "expense",
        amount: { amount: "6500.00", currency: "AOA" },
        account: "Carteira",
        category: "Transporte",
        description: "Yango",
      },
    ]);
    expect(result.hasMore).toBe(false);

    await expect(run("search_transactions", { limit: 50 })).resolves.toBeDefined();
    const limits = finance.callsTo("/transactions").map((c) => Number(c.body!.limit));
    expect(Math.max(...limits)).toBeLessThanOrEqual(20);
  });

  test("reports default to the current month in the user's timezone", async () => {
    const { run, finance } = setup();
    const summary = await run("get_transaction_summary");
    expect(finance.callsTo("/reports/transaction-summary")[0]!.body).toMatchObject({ month: "2026-11" });
    expect(summary).toMatchObject({ month: "2026-11", income: { amount: "650000.00", currency: "AOA" } });

    const spending = await run("get_spending_by_category", { month: "2026-10" });
    expect(finance.callsTo("/reports/spending-by-category")[0]!.body).toMatchObject({ month: "2026-10" });
    expect(spending.categories[0]).toMatchObject({ name: "Casa", amount: { amount: "150000.00", currency: "AOA" }, percent: 66 });

    const cashflow = await run("get_cashflow", { months: 3 });
    expect(cashflow.trend).toHaveLength(3);
    expect(cashflow.trend[2]).toMatchObject({ month: "2026-11" });
  });

  test("net worth, goals and debts", async () => {
    const { run } = setup();
    expect(await run("get_net_worth")).toEqual({
      hasData: true,
      assets: { amount: "2127320.50", currency: "AOA" },
      debts: { amount: "2185400.00", currency: "AOA" },
      netWorth: { amount: "-58079.50", currency: "AOA" },
    });
    const goals = await run("list_goals");
    expect(goals.goals[0]).toMatchObject({ name: "Carro", percent: 31, target: { amount: "4000000.00" } });
    const debts = await run("list_debts");
    expect(debts.summary).toMatchObject({ totalRemaining: { amount: "2185400.00", currency: "AOA" } });
    expect(debts.debts[0]).toMatchObject({ name: "Crédito automóvel", lender: "BFA", balance: { amount: "2000000.00" } });
  });

  test("mixed_currencies is explained in plain words", async () => {
    const { run, finance } = setup();
    finance.fail("GET /reports/spending-by-category", "conflict", 1, { reason: "mixed_currencies", currencies: ["AOA", "USD"] });
    const result = await run("get_spending_by_category");
    expect(result.error).toBe("mixed_currencies");
    expect(result.message).toMatch(/more than one currency/i);
    expect(result.message).toContain("AOA, USD");
    expect(result.message).toMatch(/not supported yet/i);
  });

  test("other API errors become tool results the model can explain", async () => {
    const { run, finance, fatal } = setup();
    finance.fail("GET /goals", "not_found");
    expect(await run("list_goals")).toMatchObject({ error: "not_found", message: expect.any(String) });
    finance.fail("GET /reports/net-worth", "network");
    expect(await run("get_net_worth")).toMatchObject({ error: "unavailable" });
    finance.fail("GET /reports/cashflow", "internal");
    expect(await run("get_cashflow")).toMatchObject({ error: "unavailable" });
    expect(fatal).toHaveLength(0);
  });

  test("a debt summary failure keeps the debt list", async () => {
    const { run, finance } = setup();
    finance.fail("GET /reports/debt-summary", "conflict", 1, { reason: "mixed_currencies", currencies: ["AOA", "USD"] });
    const result = await run("list_debts");
    expect(result.debts).toHaveLength(2);
    expect(result.summary).toMatchObject({ error: "mixed_currencies" });
  });

  test("auth and rate-limit errors are fatal: reported to the turn, not to the model", async () => {
    for (const code of ["unauthorized", "forbidden", "rate_limited"] as const) {
      const { run, finance, fatal } = setup();
      finance.fail("GET /accounts", code);
      const result = await run("list_accounts");
      expect(result).toMatchObject({ error: code });
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({ code });
    }
  });

  test("lists are bounded", async () => {
    const { run, finance } = setup();
    finance.accounts.length = 0;
    for (let i = 0; i < 120; i++) {
      finance.accounts.push({ id: `a${i}`, name: `A${i}`, type: "bank", balance: { amountMinor: i, currency: "AOA" } });
    }
    const result = await run("list_accounts");
    expect(result.accounts.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });
});
