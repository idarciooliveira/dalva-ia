import { routes } from "@mpf/finance-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  expectApiError,
  expectConforms,
  linkedChat,
  raw,
  seedAccount,
  seedDebt,
  seedDebtPayment,
  tokenFor,
  transactionRows,
  twoUsers,
} from "../../../test/api";
import { testDb } from "../../../test/db";
import { debtPayments, debts } from "../../db/schema";
import { MISSING_ACCOUNT_ID, MISSING_TRANSACTION_ID } from "./shared";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const carLoan = (userId: string, extra: { linkedAccountId?: string } = {}) =>
  seedDebt(userId, {
    name: "Car loan",
    lender: "Bank",
    originalAmount: 100_000,
    currentBalance: 80_000,
    minimumPayment: 2_000,
    createdOn: "2026-01-01",
    ...extra,
  });

const debtRow = async (id: string) => (await testDb().select().from(debts).where(eq(debts.id, id)))[0];

describe("api/v1 debts and payments", () => {
  it("lists and gets debts", async () => {
    const { app, alice } = await twoUsers();
    const debt = await carLoan(alice);
    const token = await tokenFor(alice);
    const list = expectConforms(routes.debts.list, await raw(app, "GET", "/debts", { token })) as { items: unknown[] };
    expect(list.items).toEqual([
      {
        id: debt,
        name: "Car loan",
        debtType: "loan",
        lender: "Bank",
        originalAmount: usd(100_000),
        currentBalance: usd(80_000),
        minimumPayment: usd(2_000),
        createdAt: "2026-01-01",
      },
    ]);
    expectConforms(routes.debts.get, await raw(app, "GET", `/debts/${debt}`, { token }));
  });

  it("records a payment split into principal and interest, lists and removes it", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const loan = await seedAccount(alice, { name: "Loan", type: "loan", balance: 80_000 });
    const debt = await carLoan(alice, { linkedAccountId: loan });

    const { payment } = await asAlice.debtPayments.record({
      debtId: debt,
      amount: usd(5_000),
      principalAmount: usd(4_000),
      interestAmount: usd(1_000),
      date: "2026-02-01",
      fromAccountId: aliceAccount,
    });
    expect(payment).toMatchObject({ debtId: debt, amount: usd(5_000), principalAmount: usd(4_000), interestAmount: usd(1_000), fromAccountId: aliceAccount });
    expect(payment.liabilityTransactionId).toEqual(expect.any(String));
    expect((await debtRow(debt))?.currentBalance).toBe(76_000);
    expect(await balanceOf(aliceAccount)).toBe(95_000);
    expect((await asAlice.debtPayments.list({ debtId: debt })).items).toEqual([payment]);
    expect((await asAlice.transactions.get({ id: payment.sourceTransactionId })).managedBy).toBe("debt_payment");
    await expectApiError(asAlice.transactions.delete({ id: payment.sourceTransactionId }), "conflict", 409);

    expect(await asAlice.debtPayments.remove({ id: payment.id })).toEqual({ id: payment.id });
    expect((await debtRow(debt))?.currentBalance).toBe(80_000);
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(loan)).toBe(80_000);
  });

  it("validates currency, account currency and principal limits", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const debt = await carLoan(alice);
    const eur = await seedAccount(alice, { currency: "EUR" });
    const base = { debtId: debt, date: "2026-01-01", fromAccountId: aliceAccount } as const;
    await expectApiError(asAlice.debtPayments.record({ ...base, amount: { amountMinor: 1, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.debtPayments.record({ ...base, fromAccountId: eur, amount: { amountMinor: 1, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.debtPayments.record({ ...base, amount: usd(100), principalAmount: usd(60) }), "validation_failed");
    await expectApiError(asAlice.debtPayments.record({ ...base, amount: usd(90_000) }), "validation_failed");
    expect(await balanceOf(aliceAccount)).toBe(100_000);
  });

  it("isolates users", async () => {
    const { alice, aliceAccount, bobAccount, asAlice, asBob } = await twoUsers();
    const debt = await carLoan(alice);
    const { payment } = await asAlice.debtPayments.record({ debtId: debt, amount: usd(100), date: "2026-01-01", fromAccountId: aliceAccount });
    await expectApiError(asBob.debts.get({ id: debt }), "not_found", 404);
    await expectApiError(asBob.debtPayments.list({ debtId: debt }), "not_found");
    await expectApiError(asBob.debtPayments.record({ debtId: debt, amount: usd(1), date: "2026-01-01", fromAccountId: bobAccount }), "not_found");
    await expectApiError(asAlice.debtPayments.record({ debtId: debt, amount: usd(1), date: "2026-01-01", fromAccountId: bobAccount }), "not_found");
    await expectApiError(asBob.debtPayments.remove({ id: payment.id }), "not_found");
    expect((await asBob.debts.list()).items).toEqual([]);
  });

  it("lists and removes legacy payments whose account or source row is gone", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const debt = await carLoan(alice);
    const orphan = await seedDebtPayment(alice, { debtId: debt, fromAccountId: null, amount: 500 });
    const lost = await seedDebtPayment(alice, { debtId: debt, fromAccountId: aliceAccount, amount: 700 });
    await testDb().update(debtPayments).set({ sourceTransactionId: null }).where(eq(debtPayments.id, lost.id));

    const { items } = await asAlice.debtPayments.list({ debtId: debt });
    expect(items.find((p) => p.id === orphan.id)).toMatchObject({ fromAccountId: MISSING_ACCOUNT_ID, sourceTransactionId: orphan.sourceTransactionId });
    expect(items.find((p) => p.id === lost.id)).toMatchObject({ fromAccountId: aliceAccount, sourceTransactionId: MISSING_TRANSACTION_ID });
    await expectApiError(asAlice.transactions.get({ id: MISSING_TRANSACTION_ID }), "not_found", 404);

    await asAlice.debtPayments.remove({ id: orphan.id });
    await asAlice.debtPayments.remove({ id: lost.id });
    expect((await debtRow(debt))?.currentBalance).toBe(81_200);
    // The orphan's row had no balance effect to reverse; the lost payment's row is still there, unowned now.
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await transactionRows()).toHaveLength(1);
  });

  it("creates, updates, archives, restores and deletes debts (web only)", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    const loan = await seedAccount(alice, { name: "Loan", type: "loan", balance: -80_000 });
    const created = await raw(app, "POST", "/debts", {
      token: await tokenFor(alice),
      idempotencyKey: "debt-create-01",
      body: {
        name: "Car loan",
        debtType: "loan",
        lender: "Bank",
        originalAmount: usd(100_000),
        currentBalance: usd(80_000),
        interestRate: 5.5,
        minimumPayment: usd(2_000),
        dueDate: "2026-05-01",
        linkedAccountId: loan,
      },
    });
    const { debt } = expectConforms(routes.debts.create, created) as { debt: { id: string } };
    expect(debt).toEqual({
      id: expect.any(String),
      name: "Car loan",
      debtType: "loan",
      lender: "Bank",
      originalAmount: usd(100_000),
      currentBalance: usd(80_000),
      interestRate: 5.5,
      minimumPayment: usd(2_000),
      dueDate: "2026-05-01",
      linkedAccountId: loan,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    expect((await asAlice.debts.update({ id: debt.id, currentBalance: usd(70_000), name: "Car" })).debt).toMatchObject({
      name: "Car",
      currentBalance: usd(70_000),
      originalAmount: usd(100_000),
    });
    await expectApiError(asAlice.debts.update({ id: debt.id, currentBalance: usd(100_001) }), "validation_failed");
    expect((await asAlice.debts.archive({ id: debt.id })).debt.archived).toBe(true);
    expect((await asAlice.debts.list()).items).toEqual([]);
    expect((await asAlice.debts.restore({ id: debt.id })).debt.archived).toBeUndefined();

    await asAlice.debtPayments.record({ debtId: debt.id, amount: usd(5_000), date: "2026-02-01", fromAccountId: aliceAccount });
    expect(await balanceOf(aliceAccount)).toBe(95_000);
    // The liability adjustment is -principal (Convex semantics: the loan balance goes down by the principal).
    expect(await balanceOf(loan)).toBe(-85_000);
    expect(await asAlice.debts.delete({ id: debt.id })).toEqual({ id: debt.id });
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(loan)).toBe(-80_000);
    expect(await transactionRows()).toEqual([]);
    await expectApiError(asAlice.debts.get({ id: debt.id }), "not_found", 404);
  });

  it("validates debt management input and keeps it away from chat tokens and other users", async () => {
    const { app, alice, bobAccount, asAlice, asBob } = await twoUsers();
    const eur = await seedAccount(alice, { currency: "EUR" });
    const base = { name: "Loan", debtType: "loan", originalAmount: usd(1_000), currentBalance: usd(1_000) } as const;
    await expectApiError(asAlice.debts.create({ ...base, linkedAccountId: eur }), "validation_failed");
    await expectApiError(asAlice.debts.create({ ...base, linkedAccountId: bobAccount }), "not_found");
    await expectApiError(asAlice.debts.create({ ...base, minimumPayment: { amountMinor: 1, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.debts.create({ ...base, currentBalance: usd(1_001) }), "validation_failed");

    const debt = await carLoan(alice);
    await expectApiError(asBob.debts.update({ id: debt, name: "x" }), "not_found", 404);
    await expectApiError(asBob.debts.archive({ id: debt }), "not_found");
    await expectApiError(asBob.debts.restore({ id: debt }), "not_found");
    await expectApiError(asBob.debts.delete({ id: debt }), "not_found");
    const chat = await linkedChat(app);
    await expectApiError(chat.finance.debts.create(base), "forbidden", 403);
    await expectApiError(chat.finance.debts.delete({ id: debt }), "forbidden", 403);
    expect(await debtRow(debt)).toMatchObject({ name: "Car loan", archived: false });
  });

  it("keeps balances exact under parallel payments and removals on one debt", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const loan = await seedAccount(alice, { name: "Loan", type: "loan", balance: -80_000 });
    const debt = await carLoan(alice, { linkedAccountId: loan });

    const recorded = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        asAlice.debtPayments.record({
          debtId: debt,
          amount: usd(1_000 + i),
          principalAmount: usd(800 + i),
          interestAmount: usd(200),
          date: "2026-02-01",
          fromAccountId: aliceAccount,
        }),
      ),
    );
    const paid = recorded.reduce((sum, { payment }) => sum + payment.amount.amountMinor, 0);
    const principal = recorded.reduce((sum, { payment }) => sum + payment.principalAmount.amountMinor, 0);
    expect(await balanceOf(aliceAccount)).toBe(100_000 - paid);
    expect(await balanceOf(loan)).toBe(-80_000 - principal);
    expect((await debtRow(debt))?.currentBalance).toBe(80_000 - principal);

    await Promise.all(recorded.map(({ payment }) => asAlice.debtPayments.remove({ id: payment.id })));
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(loan)).toBe(-80_000);
    expect((await debtRow(debt))?.currentBalance).toBe(80_000);
    expect(await transactionRows()).toEqual([]);
  });

  it("never pays down more than is left, even when payments race", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const debt = await seedDebt(alice, { originalAmount: 1_000, currentBalance: 1_000 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => asAlice.debtPayments.record({ debtId: debt, amount: usd(300), date: "2026-02-01", fromAccountId: aliceAccount })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "validation_failed" });
    }
    expect((await debtRow(debt))?.currentBalance).toBe(100);
    expect(await balanceOf(aliceAccount)).toBe(100_000 - 900);
  });
});
