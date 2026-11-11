import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { expectApiError, expectConforms, getDoc, raw, seedAccount, setupApi, tokenFor, twoUsers } from "./test.helpers";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

describe("api/v1 transfers", () => {
  it("creates, updates (via either leg) and deletes a transfer", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const savings = await seedAccount(t, alice, { name: "Savings", balance: 0 });

    const created = await raw(t, "POST", "/transfers", {
      token: await tokenFor(alice),
      idempotencyKey: "transfer-create-01",
      body: { amount: usd(2_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-02-01", note: "Move" },
    });
    const { transfer } = expectConforms(routes.transfers.create, created) as { transfer: Record<string, unknown> };
    expect(transfer).toMatchObject({
      amount: usd(2_000),
      fromAccountId: aliceAccount,
      toAccountId: savings,
      fromAccountName: "Checking",
      toAccountName: "Savings",
      date: "2026-02-01",
      note: "Move",
    });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(98_000);
    expect((await getDoc(t, savings))?.balance).toBe(2_000);

    const updated = await asAlice.transfers.update({ id: transfer.incomingId as string, amount: usd(500), date: "2026-02-03" });
    expect(updated.transfer).toMatchObject({ outgoingId: transfer.outgoingId, amount: usd(500), date: "2026-02-03" });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(99_500);

    expect(await asAlice.transfers.delete({ id: transfer.outgoingId as string })).toEqual({ id: transfer.outgoingId });
    expect((await getDoc(t, aliceAccount))?.balance).toBe(100_000);
    expect((await getDoc(t, savings))?.balance).toBe(0);
  });

  it("rejects cross-currency transfers and a currency mismatch", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const eur = await seedAccount(t, alice, { currency: "EUR" });
    const usd2 = await seedAccount(t, alice, { name: "Second" });
    const error = await expectApiError(
      asAlice.transfers.create({ amount: usd(100), fromAccountId: aliceAccount, toAccountId: eur, date: "2026-01-01" }),
      "validation_failed",
      400,
    );
    expect(error.message).toContain("Cross-currency");
    await expectApiError(
      asAlice.transfers.create({ amount: { amountMinor: 100, currency: "EUR" }, fromAccountId: aliceAccount, toAccountId: usd2, date: "2026-01-01" }),
      "validation_failed",
    );
    const { transfer } = await asAlice.transfers.create({ amount: usd(100), fromAccountId: aliceAccount, toAccountId: usd2, date: "2026-01-01" });
    await expectApiError(asAlice.transfers.update({ id: transfer.outgoingId, toAccountId: eur }), "validation_failed");
    await expectApiError(asAlice.transfers.update({ id: transfer.outgoingId, fromAccountId: usd2 }), "validation_failed");
    expect((await getDoc(t, eur))?.balance).toBe(0);
  });

  it("validates input: same account, non-positive amount, malformed id", async () => {
    const t = setupApi();
    const { aliceAccount, asAlice } = await twoUsers(t);
    await expectApiError(asAlice.transfers.create({ amount: usd(1), fromAccountId: aliceAccount, toAccountId: aliceAccount, date: "2026-01-01" }), "validation_failed");
    await expectApiError(asAlice.transfers.create({ amount: usd(0), fromAccountId: aliceAccount, toAccountId: "x", date: "2026-01-01" }), "validation_failed");
    await expectApiError(asAlice.transfers.delete({ id: "bad" }), "validation_failed");
  });

  it("treats non-transfer rows as not found and goal-contribution transfers as conflict", async () => {
    const t = setupApi();
    const { alice, aliceAccount, asAlice } = await twoUsers(t);
    const { transaction } = await asAlice.transactions.create({ type: "expense", amount: usd(1), accountId: aliceAccount, date: "2026-01-01" });
    await expectApiError(asAlice.transfers.update({ id: transaction.id, note: "x" }), "not_found");
    await expectApiError(asAlice.transfers.delete({ id: transaction.id }), "not_found");

    const savings = await seedAccount(t, alice, { name: "Savings" });
    const goalId = await t.run((ctx) =>
      ctx.db.insert("savingsGoals", { userId: alice, name: "Trip", targetAmount: 10_000, currentAmount: 0, linkedAccountId: savings, isVirtual: false, createdAt: "2026-01-01" }),
    );
    const { contribution } = await asAlice.goalContributions.add({ goalId, amount: usd(500), date: "2026-01-02", fromAccountId: aliceAccount });
    const outgoing = await getDoc(t, contribution.transactionId as never);
    for (const id of [contribution.transactionId!, (outgoing as { linkedTransactionId: string }).linkedTransactionId]) {
      await expectApiError(asAlice.transfers.update({ id, note: "x" }), "conflict", 409);
      await expectApiError(asAlice.transfers.delete({ id }), "conflict", 409);
    }
  });

  it("isolates users", async () => {
    const t = setupApi();
    const { alice, aliceAccount, bobAccount, asAlice, asBob } = await twoUsers(t);
    const savings = await seedAccount(t, alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(100), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    await expectApiError(asBob.transfers.update({ id: transfer.outgoingId, note: "x" }), "not_found", 404);
    await expectApiError(asBob.transfers.delete({ id: transfer.incomingId }), "not_found", 404);
    await expectApiError(asBob.transfers.create({ amount: usd(1), fromAccountId: bobAccount, toAccountId: aliceAccount, date: "2026-01-01" }), "not_found");
    await expectApiError(asAlice.transfers.update({ id: transfer.outgoingId, toAccountId: bobAccount }), "not_found");
    expect((await getDoc(t, bobAccount))?.balance).toBe(50_000);
  });
});
