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
