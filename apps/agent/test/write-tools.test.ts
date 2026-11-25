import { describe, expect, test } from "vitest";

import { SummaryTooLongError } from "../src/core/summary";
import { createTools, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/tools";
import { MAX_PROPOSALS, type Proposal, Proposals } from "../src/tools/proposals";
import { seedFinance } from "./fixtures/finance";
import { fakeFinance } from "./helpers";

const USER = "424242";
const TODAY = "2026-11-11";

function setup(options: { eventId?: string; finance?: ReturnType<typeof fakeFinance> } = {}) {
  const finance = options.finance ?? fakeFinance();
  if (!options.finance) {
    seedFinance(finance);
    finance.accounts.push(
      { id: "00000001-0000-4000-8000-000000000006", name: "Tokyo Cash", type: "cash", balance: { amountMinor: 50_000, currency: "JPY" } },
      { id: "00000001-0000-4000-8000-000000000005", name: "Kuwait Bank", type: "bank", balance: { amountMinor: 1_000_000, currency: "KWD" } },
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
  accountId: "00000001-0000-4000-8000-000000000001",
  categoryId: "00000002-0000-4000-8000-000000000001",
  subcategoryId: "00000003-0000-4000-8000-000000000001",
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
  test("proposes: converts the amount, validates, queues the change, returns the summary; the action is stored at commit", async () => {
    const { run, finance, proposals } = setup();
    const result = await run("create_transaction", expense());
    const summary = "Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje";
    expect(result).toEqual({ status: "awaiting_confirmation", summary });
    expect(finance.actions).toHaveLength(0);
    expect((await proposals.commit())?.id).toBe("action_1");
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
        accountId: "00000001-0000-4000-8000-000000000001",
        categoryId: "00000002-0000-4000-8000-000000000001",
        subcategoryId: "00000003-0000-4000-8000-000000000001",
        date: TODAY,
      },
    });
    expect(finance.writes).toHaveLength(0); // never the write route itself
  });

  test("amounts: 0-, 2- and 3-decimal currencies", async () => {
    const jpy = setup();
    expect(await jpy.run("create_transaction", { type: "expense", amount: "1500", accountId: "00000001-0000-4000-8000-000000000006", language: "en" })).toMatchObject({
      summary: "Expense · 1,500 JPY · Tokyo Cash · today",
    });
    expect(jpy.proposals.queued[0]!.input.amount).toEqual({ amountMinor: 1500, currency: "JPY" });

    const usd = setup();
    await usd.run("create_transaction", { type: "income", amount: "1240.5", accountId: "00000001-0000-4000-8000-000000000004", categoryId: "00000002-0000-4000-8000-000000000007", language: "en", date: "2026-11-10" });
    expect(usd.proposals.queued[0]!.input.amount).toEqual({ amountMinor: 124_050, currency: "USD" });
    expect(usd.proposals.queued[0]!.summary).toBe("Income · 1,240.50 USD · Freelance · Wise USD · yesterday");

    const kwd = setup();
    await kwd.run("create_transaction", { type: "expense", amount: "12.340", accountId: "00000001-0000-4000-8000-000000000005", language: "pt", date: "2026-10-01" });
    expect(kwd.proposals.queued[0]!.input.amount).toEqual({ amountMinor: 12_340, currency: "KWD" });
    expect(kwd.proposals.queued[0]!.summary).toBe("Despesa · 12,340 KWD · Kuwait Bank · 01/10/2026");
  });

  test("3-decimal amounts DALVA can't store exactly (x100) are refused at proposal time, never rounded", async () => {
    const kwd = setup();
    expect(await kwd.run("create_transaction", { type: "expense", amount: "12.345", accountId: "00000001-0000-4000-8000-000000000005", language: "pt" })).toMatchObject({
      error: "invalid_input",
      message: expect.stringMatching(/KWD only supports 2 decimal places in DALVA/),
    });
    expect(kwd.proposals.queued).toHaveLength(0);
    // "12.34" and "12.340" are the same storable amount.
    expect(await kwd.run("create_transaction", { type: "expense", amount: "12.34", accountId: "00000001-0000-4000-8000-000000000005", language: "pt" })).toMatchObject({
      status: "awaiting_confirmation",
    });
    expect(kwd.proposals.queued[0]!.input.amount).toEqual({ amountMinor: 12_340, currency: "KWD" });
  });

  test("bad input fails at proposal time and creates nothing", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ amount: "abc" }, /amount/i],
      [{ amount: "0" }, /greater than zero/i],
      [{ amount: "-5" }, /amount/i],
      [{ amount: "5000.123" }, /2 decimal/],
      [{ amount: "1,5" }, /amount/i],
      [{ accountId: "00000001-0000-4000-8000-000000000006", subcategoryId: undefined, categoryId: undefined, amount: "1.5" }, /0 decimal/],
      [{ currency: "USD" }, /AOA/],
      [{ categoryId: "00000002-0000-4000-8000-000000000004", subcategoryId: undefined }, /income category/i],
      [{ subcategoryId: "00000003-0000-4000-8000-000000000002" }, /subcategory/i],
      [{ accountId: "00000001-0000-4000-8000-000000000008" }, /archived/i],
      [{ date: "2026-02-30" }, /date/i],
    ];
    for (const [patch, message] of cases) {
      const { run, proposals } = setup();
      const result = await run("create_transaction", expense(patch));
      expect(result, JSON.stringify(patch)).toMatchObject({ error: expect.any(String), message: expect.stringMatching(message) });
      expect(proposals.queued, JSON.stringify(patch)).toHaveLength(0);
    }
    const missing = setup();
    expect(await missing.run("create_transaction", expense({ accountId: "00000001-0000-4000-8000-000000000010" }))).toMatchObject({ error: "not_found" });
  });

  test("trailing zeros past the currency's decimals are fine; an out-of-range amount is invalid input", async () => {
    const jpy = setup();
    await jpy.run("create_transaction", { type: "expense", amount: "1500.00", accountId: "00000001-0000-4000-8000-000000000006", language: "en" });
    expect(jpy.proposals.queued[0]!.input.amount).toEqual({ amountMinor: 1500, currency: "JPY" });
    const huge = setup();
    expect(await huge.run("create_transaction", expense({ amount: "999999999999999999999" }))).toMatchObject({ error: "invalid_input" });
    expect(huge.proposals.queued).toHaveLength(0);
  });

  test("a subcategory alone implies its category", async () => {
    const { run, proposals } = setup();
    await run("create_transaction", expense({ categoryId: undefined, subcategoryId: "00000003-0000-4000-8000-000000000003", language: "en" }));
    expect(proposals.queued[0]!.input).toMatchObject({ categoryId: "00000002-0000-4000-8000-000000000002", subcategoryId: "00000003-0000-4000-8000-000000000003" });
    expect(proposals.queued[0]!.summary).toBe("Expense · 5,000.00 AOA · Transporte › Táxi / Yango · BAI Conta Ordem · today");
  });

  test("description and payee go into the input and the summary", async () => {
    const { run, proposals } = setup();
    await run("create_transaction", expense({ description: "Almoço com a equipa", payee: "Café Ilha" }));
    expect(proposals.queued[0]!.input).toMatchObject({ description: "Almoço com a equipa", payee: "Café Ilha" });
    expect(proposals.queued[0]!.summary).toBe(
      "Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje · Café Ilha · “Almoço com a equipa”",
    );
  });
});

describe("several changes per turn and idempotent creation", () => {
  test("proposals queue in call order (also when they run at once) and are stored as one batch at the end", async () => {
    const { run, finance, proposals } = setup();
    const transfer = { amount: "1", fromAccountId: "00000001-0000-4000-8000-000000000001", toAccountId: "00000001-0000-4000-8000-000000000002", language: "pt" };
    const [a, b, c] = await Promise.all([
      run("create_transaction", expense()),
      run("create_transaction", expense({ amount: "10", type: "income", categoryId: "00000002-0000-4000-8000-000000000004", subcategoryId: undefined })),
      run("create_transfer", transfer),
    ]);
    for (const result of [a, b, c]) expect(result).toMatchObject({ status: "awaiting_confirmation" });
    expect(finance.actions).toHaveLength(0); // nothing stored until the turn ends
    expect(proposals.queued.map((p) => p.operation)).toEqual(["transactions.create", "transactions.create", "transfers.create"]);

    const action = await proposals.commit();
    expect(finance.actions).toHaveLength(1);
    expect(action).toMatchObject({ operation: "batch", clientKey: "5001:0", status: "pending" });
    expect(action!.summary).toBe(
      [
        "1. Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje",
        "2. Receita · 10,00 AOA · Salário · BAI Conta Ordem · hoje",
        "3. Transferência · 1,00 AOA · BAI Conta Ordem → Poupança BFA · hoje",
      ].join("\n"),
    );
    expect((action!.input as { items: unknown[] }).items).toEqual(proposals.queued.map(({ operation, input }) => ({ operation, input })));
    expect(finance.writes).toHaveLength(0);
  });

  test("a single proposal is stored as its own operation", async () => {
    const { run, finance, proposals } = setup();
    await run("create_transaction", expense());
    expect(await proposals.commit()).toMatchObject({ operation: "transactions.create", clientKey: "5001:0", sessionId: "sess_1" });
    expect(finance.actions).toHaveLength(1);
  });

  test("nothing queued stores nothing", async () => {
    const { run, finance, proposals } = setup();
    expect(await run("create_transaction", expense({ amount: "x" }))).toMatchObject({ error: "invalid_input" });
    expect(await proposals.commit()).toBeNull();
    expect(finance.actions).toHaveLength(0);
  });

  test("a failed proposal takes no slot; two identical new rows are two changes", async () => {
    const { run, proposals } = setup();
    expect(await run("create_transaction", expense({ amount: "x" }))).toMatchObject({ error: "invalid_input" });
    expect(await run("create_transaction", expense())).toEqual({ status: "awaiting_confirmation", summary: expect.any(String) });
    expect(await run("create_transaction", expense())).toEqual({ status: "awaiting_confirmation", summary: expect.any(String) });
    expect(proposals.queued).toHaveLength(2);
    expect((await proposals.commit())!.input).toMatchObject({ items: [{ operation: "transactions.create" }, { operation: "transactions.create" }] });
  });

  test("an existing row takes one change per message: a repeat is queued once, another change is refused", async () => {
    const { run, proposals } = setup();
    const id = "00000004-0000-4000-8000-000000000001";
    expect(await run("update_transaction", { id, amount: "20000", language: "pt" })).toMatchObject({ status: "awaiting_confirmation" });
    expect(await run("update_transaction", { id, amount: "20000", language: "pt" })).toMatchObject({
      status: "awaiting_confirmation",
      message: expect.stringMatching(/Already proposed/),
    });
    expect(await run("update_transaction", { id, amount: "30000", language: "pt" })).toMatchObject({ error: "invalid_input", message: expect.stringMatching(/one change per confirmation/) });
    expect(await run("delete_transaction", { id, language: "pt" })).toMatchObject({ error: "invalid_input" });
    expect(await run("delete_transaction", { id: "00000004-0000-4000-8000-000000000005", language: "pt" })).toMatchObject({ status: "awaiting_confirmation" });
    expect(proposals.queued.map((p) => [p.operation, p.input.id])).toEqual([
      ["transactions.update", id],
      ["transactions.delete", "00000004-0000-4000-8000-000000000005"],
    ]);
  });

  test("a repeat that is checked first still takes the first call's place", () => {
    const proposals = new Proposals({ finance: fakeFinance().clients.forToken("t"), eventId: "1", sessionId: async () => "s" });
    const remove: Proposal = { operation: "transactions.delete", input: { id: "00000004-0000-4000-8000-000000000001" }, summary: "Apagar" };
    const create: Proposal = { operation: "transactions.create", input: { type: "expense" }, summary: "Despesa" };
    const [first, second, repeat] = [proposals.reserve()!, proposals.reserve()!, proposals.reserve()!];
    expect(proposals.fill(second, create)).toBe("queued");
    expect(proposals.fill(repeat, { ...remove })).toBe("queued");
    expect(proposals.fill(first, remove)).toBe("duplicate");
    expect(proposals.queued.map((p) => p.summary)).toEqual(["Apagar", "Despesa"]);
  });

  test("the whole batch must fit the API's size limit for a stored input", () => {
    const proposals = new Proposals({ finance: fakeFinance().clients.forToken("t"), eventId: "1", sessionId: async () => "s" });
    // Control characters are escaped to 6 bytes each in JSON.
    const big = (n: number): Proposal => ({ operation: "transactions.create", input: { n, description: "\u0001".repeat(1500) }, summary: `Despesa ${n}` });
    expect(proposals.fill(proposals.reserve()!, big(1))).toBe("queued");
    expect(() => proposals.fill(proposals.reserve()!, big(2))).toThrow(SummaryTooLongError);
    expect(proposals.queued).toHaveLength(1);
  });

  test("the API checks each proposal against the operation's schema when it is made", async () => {
    const { run, finance, proposals } = setup();
    finance.fail("POST /agent/pending-actions/check", "validation_failed", 1, { issues: [{ path: "amount", message: "Too big" }] });
    expect(await run("create_transaction", expense())).toEqual({ error: "invalid_input", message: "Invalid request: amount: Too big" });
    expect(proposals.queued).toHaveLength(0);
  });

  test(`at most ${MAX_PROPOSALS} changes per message`, async () => {
    const { run, proposals } = setup();
    for (let i = 1; i <= MAX_PROPOSALS; i++) expect(await run("create_transaction", expense({ amount: String(i) }))).toMatchObject({ status: "awaiting_confirmation" });
    expect(await run("create_transaction", expense({ amount: "99" }))).toMatchObject({ error: "too_many" });
    expect(proposals.queued).toHaveLength(MAX_PROPOSALS);
  });

  test("replaying the same event returns the existing action, with its current status", async () => {
    const first = setup({ eventId: "7001" });
    await first.run("create_transaction", expense());
    await first.proposals.commit();
    const replay = setup({ eventId: "7001", finance: first.finance });
    await replay.run("create_transaction", expense({ amount: "6000" }));
    expect(await replay.proposals.commit()).toMatchObject({ id: first.finance.actions[0]!.id, summary: first.finance.actions[0]!.summary });
    first.finance.actions[0]!.status = "executed";
    const again = setup({ eventId: "7001", finance: first.finance });
    await again.run("create_transaction", expense());
    expect(await again.proposals.commit()).toMatchObject({ status: "executed" });
    expect(first.finance.actions).toHaveLength(1);
  });

  test("refusals from the API end the turn (read-only switched on mid-turn)", async () => {
    const { run, finance, fatal, proposals } = setup();
    finance.identities.get(USER)!.scopes = ["finance:read"];
    expect(await run("create_transaction", expense())).toMatchObject({ error: "forbidden" });
    expect(fatal).toHaveLength(1);
    expect(proposals.queued).toHaveLength(0);
  });
});

describe("update_transaction and delete_transaction", () => {
  test("update proposes only the changed fields, described against the current row", async () => {
    const { run, proposals } = setup();
    const result = await run("update_transaction", { id: "00000004-0000-4000-8000-000000000001", amount: "20000", date: "2026-11-11", language: "pt" });
    expect(proposals.queued[0]).toMatchObject({
      operation: "transactions.update",
      input: { id: "00000004-0000-4000-8000-000000000001", amount: { amountMinor: 2_000_000, currency: "AOA" }, date: TODAY },
    });
    expect(result.summary).toBe(
      "Editar despesa · valor: 18 450,00 AOA → 20 000,00 AOA · data: ontem → hoje · Alimentação › Supermercado · BAI Conta Ordem · “Kero Talatona”",
    );
  });

  test("update in English, moving to another category", async () => {
    const { run } = setup();
    const result = await run("update_transaction", { id: "00000004-0000-4000-8000-000000000005", categoryId: "00000002-0000-4000-8000-000000000003", language: "en" });
    expect(result.summary).toBe("Edit expense · category: Transporte › Táxi / Yango → Lazer · 6,500.00 AOA · Carteira · Nov 9, 2026 · “Yango”");
  });

  test("every changed field stays visible: long context is cut, then dropped; too many changes are refused", async () => {
    const { run, finance, proposals } = setup();
    const long = (prefix: string) => `${prefix} ${"x".repeat(70)}`;
    // Copies: the fixture objects are shared between tests.
    const rename = (id: string, name: string) => {
      const index = finance.accounts.findIndex((a) => a.id === id);
      finance.accounts[index] = { ...finance.accounts[index], name };
    };
    rename("00000001-0000-4000-8000-000000000001", long("Conta principal"));
    rename("00000001-0000-4000-8000-000000000003", long("Carteira de casa"));
    finance.reads.set("/transactions/00000004-0000-4000-8000-000000000003", {
      transaction: { id: "00000004-0000-4000-8000-000000000003", type: "expense", amount: { amountMinor: 100, currency: "AOA" }, accountId: "00000001-0000-4000-8000-000000000001", categoryId: "00000002-0000-4000-8000-000000000001", subcategoryId: "00000003-0000-4000-8000-000000000001", date: "2026-11-01", description: "d".repeat(200), payee: "p".repeat(100) },
    });
    const newDescription = `Novo ${"n".repeat(190)}`;
    const result = await run("update_transaction", {
      id: "00000004-0000-4000-8000-000000000003",
      amount: "20000",
      accountId: "00000001-0000-4000-8000-000000000003",
      categoryId: "00000002-0000-4000-8000-000000000002",
      subcategoryId: "00000003-0000-4000-8000-000000000002",
      date: "2026-11-11",
      description: newDescription,
      language: "pt",
    });
    expect(result.status).toBe("awaiting_confirmation");
    const summary: string = result.summary;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.startsWith("Editar despesa · valor: 1,00 AOA → 20 000,00 AOA")).toBe(true);
    for (const shown of ["conta:", "categoria:", "Transporte › Combustível", "data: 01/11/2026 → hoje", `“${newDescription}”`]) {
      expect(summary, shown).toContain(shown);
    }
    expect(proposals.queued[0]!.input).toMatchObject({ description: newDescription, accountId: "00000001-0000-4000-8000-000000000003", subcategoryId: "00000003-0000-4000-8000-000000000002" });

    // A second change to the same row would be refused in this message: a later one.
    const tooMuch = await setup({ finance, eventId: "5003" }).run("update_transaction", {
      id: "00000004-0000-4000-8000-000000000003",
      type: "income",
      amount: "20000",
      accountId: "00000001-0000-4000-8000-000000000003",
      categoryId: "00000002-0000-4000-8000-000000000007",
      date: "2026-11-11",
      description: newDescription,
      payee: "q".repeat(100),
      language: "pt",
    });
    expect(tooMuch).toMatchObject({ status: "awaiting_confirmation" });
    // Long category names plus long new texts: even without the old values it can't all fit.
    const categories = (finance.reads.get("/categories") as { items: any[] }).items;
    const subcategories = (finance.reads.get("/subcategories") as { items: any[] }).items;
    finance.reads.set("/categories", { items: [...categories, { id: "00000002-0000-4000-8000-000000000006", name: "c".repeat(80), type: "income", isDefault: false }] });
    finance.reads.set("/subcategories", { items: [...subcategories, { id: "00000003-0000-4000-8000-000000000006", categoryId: "00000002-0000-4000-8000-000000000006", name: "s".repeat(80), archived: false, sortOrder: 1 }] });
    const fresh = setup({ finance, eventId: "5002" });
    expect(
      await fresh.run("update_transaction", {
        id: "00000004-0000-4000-8000-000000000003",
        type: "income",
        amount: "20000",
        accountId: "00000001-0000-4000-8000-000000000003",
        categoryId: "00000002-0000-4000-8000-000000000006",
        subcategoryId: "00000003-0000-4000-8000-000000000006",
        date: "2026-11-11",
        description: newDescription,
        payee: "q".repeat(100),
        language: "pt",
      }),
    ).toMatchObject({ error: "too_long", message: expect.stringMatching(/fewer/) });
    expect(fresh.proposals.queued).toHaveLength(0);
  });

  test("written free text is shown in full in every summary (description, payee, note)", async () => {
    const { run } = setup();
    const description = `Jantar ${"a".repeat(180)}`;
    const payee = `Restaurante ${"b".repeat(80)}`;
    const result = await run("create_transaction", expense({ description, payee }));
    expect(result.summary).toContain(`“${description}”`);
    expect(result.summary).toContain(payee);
    const goal = setup();
    const note = `Nota ${"c".repeat(190)}`;
    expect((await goal.run("add_goal_contribution", { goalId: "00000005-0000-4000-8000-000000000002", amount: "1", note, language: "pt" })).summary).toContain(`“${note}”`);
  });

  test("update refuses no-op, managed rows and a cross-currency move without an amount", async () => {
    const { run, proposals } = setup();
    expect(await run("update_transaction", { id: "00000004-0000-4000-8000-000000000001", language: "en" })).toMatchObject({ error: "invalid_input" });
    expect(await run("update_transaction", { id: "00000004-0000-4000-8000-000000000004", amount: "1", language: "en" })).toMatchObject({
      error: "managed",
      message: expect.stringMatching(/delete_transfer/),
    });
    expect(await run("update_transaction", { id: "00000004-0000-4000-8000-000000000007", amount: "1", language: "en" })).toMatchObject({ error: "managed" });
    expect(await run("update_transaction", { id: "00000004-0000-4000-8000-000000000001", accountId: "00000001-0000-4000-8000-000000000004", language: "en" })).toMatchObject({
      message: expect.stringMatching(/amount/),
    });
    expect(await run("update_transaction", { id: "00000004-0000-4000-8000-000000000001", type: "income", language: "en" })).toMatchObject({
      message: expect.stringMatching(/category/),
    });
    expect(proposals.queued).toHaveLength(0);
  });

  test("delete describes the row being deleted", async () => {
    const { run, proposals } = setup();
    const result = await run("delete_transaction", { id: "00000004-0000-4000-8000-000000000001", language: "pt" });
    expect(proposals.queued[0]).toMatchObject({ operation: "transactions.delete", input: { id: "00000004-0000-4000-8000-000000000001" } });
    expect(result.summary).toBe("Apagar despesa · 18 450,00 AOA · ontem · Alimentação › Supermercado · BAI Conta Ordem · “Kero Talatona”");
    const managed = setup();
    expect(await managed.run("delete_transaction", { id: "00000004-0000-4000-8000-000000000002", language: "en" })).toMatchObject({ error: "managed" });
    expect(await managed.run("delete_transaction", { id: "00000004-0000-4000-8000-000000000008", language: "en" })).toMatchObject({ error: "not_found" });
  });
});

describe("transfers", () => {
  test("create: same currency only, different accounts", async () => {
    const { run, proposals } = setup();
    expect(await run("create_transfer", { amount: "20000", fromAccountId: "00000001-0000-4000-8000-000000000001", toAccountId: "00000001-0000-4000-8000-000000000004", language: "pt" })).toMatchObject({
      message: expect.stringMatching(/currenc/i),
    });
    expect(await run("create_transfer", { amount: "20000", fromAccountId: "00000001-0000-4000-8000-000000000001", toAccountId: "00000001-0000-4000-8000-000000000001", language: "pt" })).toMatchObject({
      error: "invalid_input",
    });
    const result = await run("create_transfer", { amount: "20000", fromAccountId: "00000001-0000-4000-8000-000000000001", toAccountId: "00000001-0000-4000-8000-000000000002", language: "pt" });
    expect(result.summary).toBe("Transferência · 20 000,00 AOA · BAI Conta Ordem → Poupança BFA · hoje");
    expect(proposals.queued[0]).toMatchObject({
      operation: "transfers.create",
      input: { amount: { amountMinor: 2_000_000, currency: "AOA" }, fromAccountId: "00000001-0000-4000-8000-000000000001", toAccountId: "00000001-0000-4000-8000-000000000002", date: TODAY },
    });
  });

  test("delete from either leg names both accounts; goal-contribution transfers are refused", async () => {
    const { run, proposals } = setup();
    const result = await run("delete_transfer", { id: "00000004-0000-4000-8000-000000000002", language: "en" });
    expect(result.summary).toBe("Delete transfer · 20,000.00 AOA · BAI Conta Ordem → Poupança BFA · Nov 7, 2026");
    expect(proposals.queued[0]).toMatchObject({ operation: "transfers.delete", input: { id: "00000004-0000-4000-8000-000000000002" } });
    const other = setup();
    expect(await other.run("delete_transfer", { id: "00000004-0000-4000-8000-000000000006", language: "en" })).toMatchObject({ error: "managed" });
    expect(await other.run("delete_transfer", { id: "00000004-0000-4000-8000-000000000001", language: "en" })).toMatchObject({ error: "invalid_input" });
  });
});

describe("goal contributions and debt payments", () => {
  test("a linked goal needs the source account; the summary names goal and account", async () => {
    const { run, proposals } = setup();
    expect(await run("add_goal_contribution", { goalId: "00000005-0000-4000-8000-000000000001", amount: "50000", language: "pt" })).toMatchObject({
      message: expect.stringMatching(/account/),
    });
    const result = await run("add_goal_contribution", { goalId: "00000005-0000-4000-8000-000000000001", amount: "50000", fromAccountId: "00000001-0000-4000-8000-000000000001", language: "pt" });
    expect(result.summary).toBe("Contribuição para meta · 50 000,00 AOA · Carro · de BAI Conta Ordem · hoje");
    expect(proposals.queued[0]).toMatchObject({
      operation: "goalContributions.add",
      input: { goalId: "00000005-0000-4000-8000-000000000001", amount: { amountMinor: 5_000_000, currency: "AOA" }, fromAccountId: "00000001-0000-4000-8000-000000000001", date: TODAY },
    });
  });

  test("a virtual goal takes no account", async () => {
    const { run, proposals } = setup();
    const result = await run("add_goal_contribution", { goalId: "00000005-0000-4000-8000-000000000002", amount: "10000", language: "en" });
    expect(result.summary).toBe("Goal contribution · 10,000.00 AOA · Viagem a Lisboa · today");
    expect(proposals.queued[0]!.input).not.toHaveProperty("fromAccountId");
  });

  test("debt payment with interest splits principal and interest", async () => {
    const { run, proposals } = setup();
    const result = await run("record_debt_payment", { debtId: "00000006-0000-4000-8000-000000000001", amount: "95000", interest: "5000", fromAccountId: "00000001-0000-4000-8000-000000000001", language: "en" });
    expect(proposals.queued[0]).toMatchObject({
      operation: "debtPayments.record",
      input: {
        debtId: "00000006-0000-4000-8000-000000000001",
        amount: { amountMinor: 9_500_000, currency: "AOA" },
        principalAmount: { amountMinor: 9_000_000, currency: "AOA" },
        interestAmount: { amountMinor: 500_000, currency: "AOA" },
        fromAccountId: "00000001-0000-4000-8000-000000000001",
        date: TODAY,
      },
    });
    expect(result.summary).toBe("Debt payment · 95,000.00 AOA · Crédito automóvel · from BAI Conta Ordem · today · interest 5,000.00 AOA");
    const over = setup();
    expect(await over.run("record_debt_payment", { debtId: "00000006-0000-4000-8000-000000000001", amount: "2000000.01", fromAccountId: "00000001-0000-4000-8000-000000000001", language: "pt" })).toMatchObject({
      error: "invalid_input",
      message: expect.stringMatching(/2 000 000,00 AOA/),
    });
    // Interest doesn't count against the balance.
    expect(
      await over.run("record_debt_payment", { debtId: "00000006-0000-4000-8000-000000000001", amount: "2100000", interest: "100000", fromAccountId: "00000001-0000-4000-8000-000000000001", language: "pt" }),
    ).toMatchObject({ status: "awaiting_confirmation" });
    const bad = setup();
    expect(await bad.run("record_debt_payment", { debtId: "00000006-0000-4000-8000-000000000001", amount: "100", interest: "200", fromAccountId: "00000001-0000-4000-8000-000000000001", language: "en" })).toMatchObject({
      error: "invalid_input",
    });
    expect(await bad.run("record_debt_payment", { debtId: "00000006-0000-4000-8000-000000000001", amount: "100", fromAccountId: "00000001-0000-4000-8000-000000000004", language: "en" })).toMatchObject({
      message: expect.stringMatching(/AOA/),
    });
  });
});
