import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import * as accounts from "./domain/accounts";
import * as debtPayments from "./domain/debtPayments";
import * as transactions from "./domain/transactions";
import * as debts from "./domain/debts";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedAccount(t: T, userId: string, balance = 10000) {
  return await t.run((ctx) =>
    accounts.createAccount(ctx, userId, { name: "Acct", type: "bank", balance, currency: "USD" }),
  );
}

async function balanceOf(t: T, id: Id<"accounts">) {
  return (await t.run((ctx) => ctx.db.get(id)))?.balance;
}

async function seedDebt(t: T, userId: string, linkedAccountId?: Id<"accounts">) {
  return await t.run((ctx) =>
    debts.createDebt(ctx, userId, {
      name: "Car loan",
      debtType: "loan",
      originalAmount: 10000,
      currentBalance: 8000,
      ...(linkedAccountId ? { linkedAccountId } : {}),
    }),
  );
}

describe("domain/debtPayments", () => {
  it("records a payment, updating balances, and removes it again", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000);
    const liability = await seedAccount(t, ALICE, -8000);
    const debtId = await seedDebt(t, ALICE, liability);

    const id = await t.run((ctx) =>
      debtPayments.recordDebtPayment(ctx, ALICE, {
        debtId,
        amount: 1500,
        principalAmount: 1000,
        interestAmount: 500,
        date: "2026-01-01",
        fromAccountId: from,
      }),
    );
    expect(await balanceOf(t, from)).toBe(8500);
    expect(await balanceOf(t, liability)).toBe(-9000);
    expect(await t.run((ctx) => ctx.db.get(debtId))).toMatchObject({ currentBalance: 7000 });
    expect(await t.run((ctx) => debtPayments.listDebtPayments(ctx, ALICE, { debtId }))).toHaveLength(1);

    await t.run((ctx) => debtPayments.removeDebtPayment(ctx, ALICE, { id }));
    expect(await balanceOf(t, from)).toBe(10000);
    expect(await balanceOf(t, liability)).toBe(-8000);
    expect(await t.run((ctx) => ctx.db.get(debtId))).toMatchObject({ currentBalance: 8000 });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  it("validates payment amounts", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE);
    const debtId = await seedDebt(t, ALICE);
    const base = { debtId, date: "2026-01-01", fromAccountId: from };

    await expect(
      t.run((ctx) => debtPayments.recordDebtPayment(ctx, ALICE, { ...base, amount: 0 })),
    ).rejects.toThrow("Amount must be positive");
    await expect(
      t.run((ctx) =>
        debtPayments.recordDebtPayment(ctx, ALICE, { ...base, amount: 100, principalAmount: 50 }),
      ),
    ).rejects.toThrow("Principal and interest must add up to the payment amount");
    await expect(
      t.run((ctx) => debtPayments.recordDebtPayment(ctx, ALICE, { ...base, amount: 9000 })),
    ).rejects.toThrow("Principal amount cannot exceed the remaining balance");
  });

  describe("cross-user ownership", () => {
    it("rejects paying or listing another user's debt", async () => {
      const t = setupTest();
      const aliceDebt = await seedDebt(t, ALICE);
      const bobAccount = await seedAccount(t, BOB);

      await expect(
        t.run((ctx) =>
          debtPayments.recordDebtPayment(ctx, BOB, {
            debtId: aliceDebt,
            amount: 100,
            date: "2026-01-01",
            fromAccountId: bobAccount,
          }),
        ),
      ).rejects.toThrow("Debt not found");
      await expect(
        t.run((ctx) => debtPayments.listDebtPayments(ctx, BOB, { debtId: aliceDebt })),
      ).rejects.toThrow("Debt not found");
    });

    it("rejects paying from another user's account", async () => {
      const t = setupTest();
      const debtId = await seedDebt(t, ALICE);
      const theirs = await seedAccount(t, BOB);
      await expect(
        t.run((ctx) =>
          debtPayments.recordDebtPayment(ctx, ALICE, {
            debtId,
            amount: 100,
            date: "2026-01-01",
            fromAccountId: theirs,
          }),
        ),
      ).rejects.toThrow("Account not found");
      expect(await balanceOf(t, theirs)).toBe(10000);
    });

    it("rejects removing another user's payment", async () => {
      const t = setupTest();
      const from = await seedAccount(t, ALICE);
      const debtId = await seedDebt(t, ALICE);
      const id = await t.run((ctx) =>
        debtPayments.recordDebtPayment(ctx, ALICE, {
          debtId,
          amount: 100,
          date: "2026-01-01",
          fromAccountId: from,
        }),
      );
      const op = (ctx: MutationCtx) => debtPayments.removeDebtPayment(ctx, BOB, { id });
      await expect(t.run(op)).rejects.toThrow("Debt payment not found");
      expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
      expect(await balanceOf(t, from)).toBe(9900);
    });
  });

  it("refuses plain delete/update of the debt payment's source and liability transactions", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000);
    const liability = await seedAccount(t, ALICE, -8000);
    const debtId = await seedDebt(t, ALICE, liability);
    const paymentId = await t.run((ctx) =>
      debtPayments.recordDebtPayment(ctx, ALICE, {
        debtId,
        amount: 1000,
        date: "2026-01-02",
        fromAccountId: from,
      }),
    );
    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    const fromBalance = await balanceOf(t, from);
    const liabilityBalance = await balanceOf(t, liability);
    for (const id of [payment!.sourceTransactionId, payment!.liabilityTransactionId!]) {
      await expect(
        t.run((ctx) => transactions.deleteTransaction(ctx, ALICE, { id })),
      ).rejects.toThrow("Use the debt payment delete for debt payments");
      await expect(
        t.run((ctx) => transactions.updateTransaction(ctx, ALICE, { id, note: "x" })),
      ).rejects.toThrow("Use the debt payment update for debt payments");
    }
    expect(await t.run((ctx) => ctx.db.get(paymentId))).not.toBeNull();
    expect(await balanceOf(t, from)).toBe(fromBalance);
    expect(await balanceOf(t, liability)).toBe(liabilityBalance);
  });
});
