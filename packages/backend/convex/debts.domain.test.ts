import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import * as accounts from "./domain/accounts";
import * as debts from "./domain/debts";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedDebt(
  t: T,
  userId: string,
  overrides: Partial<Parameters<typeof debts.createDebt>[2]> = {},
) {
  return await t.run((ctx) =>
    debts.createDebt(ctx, userId, {
      name: "Car loan",
      debtType: "loan",
      originalAmount: 10000,
      currentBalance: 8000,
      ...overrides,
    }),
  );
}

describe("domain/debts", () => {
  it("creates, lists, gets, updates, archives, restores and deletes for the given user", async () => {
    const t = setupTest();
    const id = await seedDebt(t, ALICE, { lender: "Bank" });

    expect(await t.run((ctx) => debts.getDebt(ctx, ALICE, { id }))).toMatchObject({
      userId: ALICE,
      name: "Car loan",
      lender: "Bank",
    });
    expect(await t.run((ctx) => debts.listDebts(ctx, ALICE, {}))).toHaveLength(1);

    await t.run((ctx) => debts.updateDebt(ctx, ALICE, { id, currentBalance: 5000 }));
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ currentBalance: 5000 });

    await t.run((ctx) => debts.archiveDebt(ctx, ALICE, { id }));
    expect(await t.run((ctx) => debts.listDebts(ctx, ALICE, {}))).toHaveLength(0);
    expect(await t.run((ctx) => debts.listDebts(ctx, ALICE, { includeArchived: true }))).toHaveLength(1);
    await t.run((ctx) => debts.restoreDebt(ctx, ALICE, { id }));
    expect(await t.run((ctx) => debts.listDebts(ctx, ALICE, {}))).toHaveLength(1);

    await t.run((ctx) => debts.deleteDebt(ctx, ALICE, { id }));
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  it("validates amounts", async () => {
    const t = setupTest();
    await expect(seedDebt(t, ALICE, { originalAmount: 0, currentBalance: 0 })).rejects.toThrow(
      "Original amount must be positive",
    );
    await expect(seedDebt(t, ALICE, { currentBalance: -1 })).rejects.toThrow(
      "Current balance cannot be negative",
    );
    await expect(seedDebt(t, ALICE, { currentBalance: 10001 })).rejects.toThrow(
      "Current balance cannot exceed original amount",
    );
  });

  it("summarises only the given user's active debts", async () => {
    const t = setupTest();
    await seedDebt(t, ALICE, { currentBalance: 4000 });
    await seedDebt(t, BOB, { currentBalance: 9000 });

    const summary = await t.run((ctx) => debts.getDebtSummary(ctx, ALICE));
    expect(summary).toMatchObject({ totalOriginal: 10000, totalRemaining: 4000 });
    expect(summary.debts).toHaveLength(1);
  });

  it("deletes every payment and reverses it, past the 500-row batch", async () => {
    const t = setupTest();
    const from = await t.run((ctx) =>
      accounts.createAccount(ctx, ALICE, { name: "A", type: "bank", balance: 10_000, currency: "USD" }),
    );
    const id = await seedDebt(t, ALICE);
    await t.run(async (ctx) => {
      for (let i = 0; i < 501; i++) {
        const sourceTransactionId = await ctx.db.insert("transactions", {
          userId: ALICE, type: "expense", amount: 1, accountId: from, date: "2026-01-01",
        });
        await ctx.db.insert("debtPayments", {
          userId: ALICE, debtId: id, amount: 1, principalAmount: 1, interestAmount: 0,
          date: "2026-01-01", fromAccountId: from, sourceTransactionId,
        });
      }
      const account = await ctx.db.get(from);
      await ctx.db.patch(from, { balance: account!.balance - 501 });
    });

    await t.run((ctx) => debts.deleteDebt(ctx, ALICE, { id }));
    expect(await t.run((ctx) => ctx.db.query("debtPayments").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(from)))?.balance).toBe(10_000);
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const t = setupTest();
      const id = await seedDebt(t, ALICE);
      const ops: Array<(ctx: MutationCtx) => Promise<unknown>> = [
        (ctx) => debts.getDebt(ctx, BOB, { id }),
        (ctx) => debts.updateDebt(ctx, BOB, { id, name: "x" }),
        (ctx) => debts.archiveDebt(ctx, BOB, { id }),
        (ctx) => debts.restoreDebt(ctx, BOB, { id }),
        (ctx) => debts.deleteDebt(ctx, BOB, { id }),
      ];
      for (const op of ops) {
        await expect(t.run(op)).rejects.toThrow("Debt not found");
      }
      expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ userId: ALICE, name: "Car loan" });
      expect(await t.run((ctx) => debts.listDebts(ctx, BOB, {}))).toEqual([]);
    });

    it("rejects linking a debt to another user's account", async () => {
      const t = setupTest();
      const theirs: Id<"accounts"> = await t.run((ctx) =>
        accounts.createAccount(ctx, BOB, { name: "B", type: "bank", balance: 0, currency: "USD" }),
      );
      await expect(seedDebt(t, ALICE, { linkedAccountId: theirs })).rejects.toThrow("Account not found");
    });
  });
});
