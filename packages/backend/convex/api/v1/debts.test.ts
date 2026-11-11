import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { expectApiError, expectConforms, getDoc, raw, seedAccount, setupApi, tokenFor, twoUsers, type T } from "./test.helpers";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const seedDebt = (t: T, userId: string, extra: { linkedAccountId?: Id<"accounts"> } = {}) =>
  t.run((ctx) =>
    ctx.db.insert("debts", {
      userId,
      name: "Car loan",
      debtType: "loan",
      lender: "Bank",
      originalAmount: 100_000,
      currentBalance: 80_000,
      minimumPayment: 2_000,
      createdAt: "2026-01-01",
      ...extra,
    }),
  );

describe("api/v1 debts and payments", () => {
  it("lists and gets debts", async () => {
    const t = setupApi();
    const { alice } = await twoUsers(t);
    const debt = await seedDebt(t, alice);
    const token = await tokenFor(alice);
    const list = expectConforms(routes.debts.list, await raw(t, "GET", "/debts", { token })) as { items: unknown[] };
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
    expectConforms(routes.debts.get, await raw(t, "GET", `/debts/${debt}`, { token }));
  });

  it("records a payment split into principal and interest, lists and removes it", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const loan = await seedAccount(t, alice, { name: "Loan", type: "loan", balance: 80_000 });
    const debt = await seedDebt(t, alice, { linkedAccountId: loan });

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
    expect((await getDoc(t, debt))?.currentBalance).toBe(76_000);
    expect((await getDoc(t, aliceAccount))?.balance).toBe(95_000);
    expect((await asAlice.debtPayments.list({ debtId: debt })).items).toEqual([payment]);

    expect(await asAlice.debtPayments.remove({ id: payment.id })).toEqual({ id: payment.id });
    expect((await getDoc(t, debt))?.currentBalance).toBe(80_000);
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
  });

  it("validates currency, account currency and principal limits", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const debt = await seedDebt(t, alice);
    const eur = await seedAccount(t, alice, { currency: "EUR" });
    const base = { debtId: debt, date: "2026-01-01", fromAccountId: aliceAccount } as const;
    await expectApiError(asAlice.debtPayments.record({ ...base, amount: { amountMinor: 1, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.debtPayments.record({ ...base, fromAccountId: eur, amount: { amountMinor: 1, currency: "EUR" } }), "validation_failed");
    await expectApiError(asAlice.debtPayments.record({ ...base, amount: usd(100), principalAmount: usd(60) }), "validation_failed");
    await expectApiError(asAlice.debtPayments.record({ ...base, amount: usd(90_000) }), "validation_failed");
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
  });

  it("isolates users", async () => {
    const t = setupApi();
    const { alice, aliceAccount, bobAccount, asAlice, asBob } = await twoUsers(t);
    const debt = await seedDebt(t, alice);
    const { payment } = await asAlice.debtPayments.record({ debtId: debt, amount: usd(100), date: "2026-01-01", fromAccountId: aliceAccount });
    await expectApiError(asBob.debts.get({ id: debt }), "not_found", 404);
    await expectApiError(asBob.debtPayments.list({ debtId: debt }), "not_found");
    await expectApiError(asBob.debtPayments.record({ debtId: debt, amount: usd(1), date: "2026-01-01", fromAccountId: bobAccount }), "not_found");
    await expectApiError(asAlice.debtPayments.record({ debtId: debt, amount: usd(1), date: "2026-01-01", fromAccountId: bobAccount }), "not_found");
    await expectApiError(asBob.debtPayments.remove({ id: payment.id }), "not_found");
    expect((await asBob.debts.list()).items).toEqual([]);
  });
});
