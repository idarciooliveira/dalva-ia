import { describe, expect, it } from "vitest";
import * as accounts from "./domain/accounts";
import * as transactions from "./domain/transactions";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

async function seedAccount(
  t: ReturnType<typeof setupTest>,
  userId: string,
  overrides: Partial<Parameters<typeof accounts.createAccount>[2]> = {},
) {
  return await t.run((ctx) =>
    accounts.createAccount(ctx, userId, {
      name: "Checking",
      type: "bank",
      balance: 10000,
      currency: "USD",
      ...overrides,
    }),
  );
}

describe("domain/accounts", () => {
  it("creates and lists accounts for an explicit userId", async () => {
    const t = setupTest();
    await seedAccount(t, ALICE, { name: "Alice", theme: "forest" });
    await seedAccount(t, BOB, { name: "Bob" });

    const aliceAccounts = await t.run((ctx) =>
      accounts.listAccounts(ctx, ALICE, {}),
    );
    expect(aliceAccounts).toHaveLength(1);
    expect(aliceAccounts[0]).toMatchObject({
      userId: ALICE,
      name: "Alice",
      theme: "forest",
      balance: 10000,
    });
  });

  it("excludes archived accounts unless includeArchived is set", async () => {
    const t = setupTest();
    const id = await seedAccount(t, ALICE);
    await t.run((ctx) => accounts.archiveAccount(ctx, ALICE, { id }));

    expect(await t.run((ctx) => accounts.listAccounts(ctx, ALICE, {}))).toEqual(
      [],
    );
    expect(
      await t.run((ctx) =>
        accounts.listAccounts(ctx, ALICE, { includeArchived: true }),
      ),
    ).toHaveLength(1);

    await t.run((ctx) => accounts.restoreAccount(ctx, ALICE, { id }));
    expect(await t.run((ctx) => accounts.listAccounts(ctx, ALICE, {}))).toHaveLength(1);
  });

  it("updates only provided fields", async () => {
    const t = setupTest();
    const id = await seedAccount(t, ALICE);
    await t.run((ctx) =>
      accounts.updateAccount(ctx, ALICE, { id, name: "Renamed" }),
    );
    const account = await t.run((ctx) => accounts.getAccount(ctx, ALICE, { id }));
    expect(account).toMatchObject({ name: "Renamed", type: "bank" });
  });

  it("adjustBalance records an adjustment transaction and updates the balance", async () => {
    const t = setupTest();
    const id = await seedAccount(t, ALICE);
    await t.run((ctx) =>
      accounts.adjustBalance(ctx, ALICE, {
        id,
        amount: -2500,
        date: "2026-01-02",
        note: "fix",
      }),
    );
    const { account, txs } = await t.run(async (ctx) => ({
      account: await ctx.db.get(id),
      txs: await ctx.db.query("transactions").collect(),
    }));
    expect(account?.balance).toBe(7500);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      userId: ALICE,
      type: "adjustment",
      amount: -2500,
      date: "2026-01-02",
      description: "Balance adjustment",
      note: "fix",
    });
  });

  it("deletes an account", async () => {
    const t = setupTest();
    const id = await seedAccount(t, ALICE);
    await t.run((ctx) => accounts.deleteAccount(ctx, ALICE, { id }));
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  it("refuses to delete an account that transactions reference", async () => {
    const t = setupTest();
    const id = await seedAccount(t, ALICE);
    await t.run((ctx) =>
      transactions.createTransaction(ctx, ALICE, {
        type: "expense",
        amount: 100,
        accountId: id,
        date: "2026-01-01",
      }),
    );
    await expect(
      t.run((ctx) => accounts.deleteAccount(ctx, ALICE, { id })),
    ).rejects.toThrow(/archive/i);
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  });

  it("refuses to delete an account linked to a goal or a debt", async () => {
    const t = setupTest();
    const goalAcc = await seedAccount(t, ALICE);
    const debtAcc = await seedAccount(t, ALICE);
    await t.run(async (ctx) => {
      await ctx.db.insert("savingsGoals", {
        userId: ALICE,
        name: "g",
        targetAmount: 100,
        currentAmount: 0,
        isVirtual: false,
        linkedAccountId: goalAcc,
        createdAt: "2026-01-01",
      });
      await ctx.db.insert("debts", {
        userId: ALICE,
        name: "d",
        debtType: "loan",
        originalAmount: 100,
        currentBalance: 100,
        linkedAccountId: debtAcc,
        createdAt: "2026-01-01",
      });
    });
    await expect(
      t.run((ctx) => accounts.deleteAccount(ctx, ALICE, { id: goalAcc })),
    ).rejects.toThrow(/archive/i);
    await expect(
      t.run((ctx) => accounts.deleteAccount(ctx, ALICE, { id: debtAcc })),
    ).rejects.toThrow(/archive/i);
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const t = setupTest();
      const id = await seedAccount(t, ALICE);

      const ops: Array<(ctx: Parameters<Parameters<typeof t.run>[0]>[0]) => Promise<unknown>> = [
        (ctx) => accounts.getAccount(ctx, BOB, { id }),
        (ctx) => accounts.updateAccount(ctx, BOB, { id, name: "x" }),
        (ctx) => accounts.archiveAccount(ctx, BOB, { id }),
        (ctx) => accounts.restoreAccount(ctx, BOB, { id }),
        (ctx) => accounts.deleteAccount(ctx, BOB, { id }),
        (ctx) => accounts.adjustBalance(ctx, BOB, { id, amount: 1 }),
      ];
      for (const op of ops) {
        await expect(t.run(op)).rejects.toThrow("Account not found");
      }

      const untouched = await t.run((ctx) => ctx.db.get(id));
      expect(untouched).toMatchObject({ userId: ALICE, balance: 10000 });
      expect(await t.run((ctx) => accounts.listAccounts(ctx, BOB, {}))).toEqual([]);
    });
  });
});
