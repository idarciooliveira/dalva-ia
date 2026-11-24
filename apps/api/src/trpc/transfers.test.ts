import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  balanceOf,
  expectApiError,
  getTransactionRow,
  expectOk,
  raw,
  seedAccount,
  seedChannelIdentity,
  seedContribution,
  seedTransaction,
  tokenFor,
  transactionRows,
  twoUsers,
} from "../../test/api";
import { testDb } from "../../test/db";
import { transactions } from "../db/schema";
import { MISSING_ACCOUNT_ID } from "./dto";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

describe("transfers", () => {
  it("creates, updates (via either leg) and deletes a transfer", async () => {
    const { app, alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });

    const created = await raw(
      app,
      "transfers.create",
      { amount: usd(2_000), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-02-01", note: "Move" },
      { token: await tokenFor(alice), idempotencyKey: "transfer-create-01" },
    );
    const { transfer } = expectOk(created) as { transfer: Record<string, unknown> };
    expect(transfer).toEqual({
      outgoingId: expect.any(String),
      incomingId: expect.any(String),
      transferGroupId: expect.any(String),
      amount: usd(2_000),
      fromAccountId: aliceAccount,
      toAccountId: savings,
      fromAccountName: "Checking",
      toAccountName: "Savings",
      date: "2026-02-01",
      note: "Move",
    });
    expect(await balanceOf(aliceAccount)).toBe(98_000);
    expect(await balanceOf(savings)).toBe(2_000);

    const updated = await asAlice.transfers.update({ id: transfer.incomingId as string, amount: usd(500), date: "2026-02-03" });
    expect(updated.transfer).toMatchObject({ outgoingId: transfer.outgoingId, incomingId: transfer.incomingId, amount: usd(500), date: "2026-02-03", note: "Move" });
    expect(await balanceOf(aliceAccount)).toBe(99_500);

    // Moving only the source is a valid edit.
    const third = await seedAccount(alice, { name: "Third", balance: 1_000 });
    const moved = await asAlice.transfers.update({ id: transfer.outgoingId as string, fromAccountId: third });
    expect(moved.transfer).toMatchObject({ fromAccountId: third, toAccountId: savings, fromAccountName: "Third", amount: usd(500) });
    expect([await balanceOf(aliceAccount), await balanceOf(third)]).toEqual([100_000, 500]);
    await asAlice.transfers.update({ id: transfer.outgoingId as string, fromAccountId: aliceAccount });

    expect(await asAlice.transfers.delete({ id: transfer.outgoingId as string })).toEqual({ id: transfer.outgoingId });
    expect(await balanceOf(aliceAccount)).toBe(100_000);
    expect(await balanceOf(savings)).toBe(0);
    expect(await transactionRows()).toEqual([]);
  });

  it("clears description and note on both legs with null", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({
      amount: usd(1_000),
      fromAccountId: aliceAccount,
      toAccountId: savings,
      date: "2026-01-01",
      description: "Rent pot",
      note: "monthly",
    });
    const updated = await asAlice.transfers.update({ id: transfer.incomingId, description: null, note: null });
    expect(updated.transfer).not.toHaveProperty("description");
    expect(updated.transfer).not.toHaveProperty("note");
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      expect(await getTransactionRow(id)).toMatchObject({ description: null, note: null, amount: 1_000 });
    }
  });

  it("gets a transfer by either leg, and not_found for anything else", async () => {
    const { app, alice, aliceAccount, asAlice, asBob } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(300), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01", note: "n" });
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      expect((await asAlice.transfers.get({ id })).transfer).toEqual(transfer);
    }
    expectOk(await raw(app, "transfers.get", { id: transfer.incomingId }, { token: await tokenFor(alice) }));

    const plain = await seedTransaction(alice, aliceAccount);
    await expectApiError(asAlice.transfers.get({ id: plain }), "not_found", 404);
    await expectApiError(asBob.transfers.get({ id: transfer.outgoingId }), "not_found", 404);
    await expectApiError(asAlice.transfers.get({ id: "bad" }), "validation_failed", 400);
    // A leg whose pair is gone (legacy) is not a transfer one can show.
    const lonely = await seedTransaction(alice, aliceAccount, { type: "transfer" });
    await expectApiError(asAlice.transfers.get({ id: lonely }), "not_found");
  });

  it("is web-only: chat tokens can't read a transfer", async () => {
    const { app, alice, aliceAccount } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const chat = await tokenFor(alice, undefined, { channelIdentityId: await seedChannelIdentity(alice) });
    const created = await raw(
      app,
      "transfers.create",
      { amount: usd(10), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" },
      { token: chat, idempotencyKey: "transfer-chat-0001" },
    );
    const { transfer } = expectOk(created) as { transfer: { outgoingId: string } };
    const response = await raw(app, "transfers.get", { id: transfer.outgoingId }, { token: chat });
    expect(response.status).toBe(403);
  });

  it("names a legacy leg's missing account", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(300), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    await testDb().update(transactions).set({ accountId: null }).where(eq(transactions.id, transfer.incomingId));
    expect((await asAlice.transfers.get({ id: transfer.outgoingId })).transfer).toMatchObject({
      toAccountId: MISSING_ACCOUNT_ID,
      toAccountName: "Unknown",
    });
    // Moving it onto a live account works; the orphaned leg's balance effect is gone with its account.
    await asAlice.transfers.update({ id: transfer.outgoingId, toAccountId: savings });
    expect(await balanceOf(savings)).toBe(600);
  });

  it("rejects cross-currency transfers and a currency mismatch", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const eur = await seedAccount(alice, { currency: "EUR" });
    const usd2 = await seedAccount(alice, { name: "Second" });
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
    expect(await balanceOf(eur)).toBe(0);
  });

  it("requires a new amount to move a transfer to accounts in another currency", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const usd2 = await seedAccount(alice, { name: "Second" });
    const eur1 = await seedAccount(alice, { currency: "EUR", balance: 1_000 });
    const eur2 = await seedAccount(alice, { currency: "EUR", name: "Euro 2" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(100), fromAccountId: aliceAccount, toAccountId: usd2, date: "2026-01-01" });
    await expectApiError(asAlice.transfers.update({ id: transfer.outgoingId, fromAccountId: eur1, toAccountId: eur2 }), "validation_failed");
    const moved = await asAlice.transfers.update({
      id: transfer.outgoingId,
      fromAccountId: eur1,
      toAccountId: eur2,
      amount: { amountMinor: 90, currency: "EUR" },
    });
    expect(moved.transfer).toMatchObject({ amount: { amountMinor: 90, currency: "EUR" }, fromAccountId: eur1, toAccountId: eur2 });
    expect([await balanceOf(aliceAccount), await balanceOf(usd2), await balanceOf(eur1), await balanceOf(eur2)]).toEqual([100_000, 0, 910, 90]);
  });

  it("validates input: same account, non-positive amount, malformed id", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    await expectApiError(asAlice.transfers.create({ amount: usd(1), fromAccountId: aliceAccount, toAccountId: aliceAccount, date: "2026-01-01" }), "validation_failed");
    await expectApiError(asAlice.transfers.create({ amount: usd(0), fromAccountId: aliceAccount, toAccountId: "x", date: "2026-01-01" }), "validation_failed");
    await expectApiError(asAlice.transfers.delete({ id: "bad" }), "validation_failed");
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(1), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    // Moving only one side onto the other side's account.
    await expectApiError(asAlice.transfers.update({ id: transfer.outgoingId, toAccountId: aliceAccount }), "validation_failed");
  });

  it("treats non-transfer rows as not found and goal-contribution transfers as conflict", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const { transaction } = await asAlice.transactions.create({ type: "expense", amount: usd(1), accountId: aliceAccount, date: "2026-01-01" });
    await expectApiError(asAlice.transfers.update({ id: transaction.id, note: "x" }), "not_found");
    await expectApiError(asAlice.transfers.delete({ id: transaction.id }), "not_found");

    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(500), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-02" });
    await seedContribution(alice, transfer.outgoingId, savings);
    for (const id of [transfer.outgoingId, transfer.incomingId]) {
      await expectApiError(asAlice.transfers.update({ id, note: "x" }), "conflict", 409);
      await expectApiError(asAlice.transfers.delete({ id }), "conflict", 409);
    }
  });

  it("isolates users", async () => {
    const { alice, aliceAccount, bobAccount, asAlice, asBob } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings" });
    const { transfer } = await asAlice.transfers.create({ amount: usd(100), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" });
    await expectApiError(asBob.transfers.update({ id: transfer.outgoingId, note: "x" }), "not_found", 404);
    await expectApiError(asBob.transfers.delete({ id: transfer.incomingId }), "not_found", 404);
    await expectApiError(asBob.transfers.create({ amount: usd(1), fromAccountId: bobAccount, toAccountId: aliceAccount, date: "2026-01-01" }), "not_found");
    await expectApiError(asAlice.transfers.update({ id: transfer.outgoingId, toAccountId: bobAccount }), "not_found");
    expect(await balanceOf(bobAccount)).toBe(50_000);
  });

  it("keeps both balances exact under parallel transfers in both directions", async () => {
    const { alice, aliceAccount, asAlice } = await twoUsers();
    const savings = await seedAccount(alice, { name: "Savings", balance: 100_000 });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? asAlice.transfers.create({ amount: usd(1_000 + i), fromAccountId: aliceAccount, toAccountId: savings, date: "2026-01-01" })
          : asAlice.transfers.create({ amount: usd(500 + i), fromAccountId: savings, toAccountId: aliceAccount, date: "2026-01-01" }),
      ),
    );
    const net = results.reduce((sum, { transfer }) => sum + (transfer.fromAccountId === aliceAccount ? -1 : 1) * transfer.amount.amountMinor, 0);
    expect(await balanceOf(aliceAccount)).toBe(100_000 + net);
    expect(await balanceOf(savings)).toBe(100_000 - net);

    // Then update and delete them all at once.
    await Promise.all(
      results.map(({ transfer }, i) =>
        i % 3 === 0 ? asAlice.transfers.delete({ id: transfer.incomingId }) : asAlice.transfers.update({ id: transfer.outgoingId, amount: usd(10) }),
      ),
    );
    const after = results.reduce(
      (sum, { transfer }, i) => (i % 3 === 0 ? sum : sum + (transfer.fromAccountId === aliceAccount ? -10 : 10)),
      0,
    );
    expect(await balanceOf(aliceAccount)).toBe(100_000 + after);
    expect(await balanceOf(savings)).toBe(100_000 - after);
    expect(await transactionRows()).toHaveLength(16);
  });
});
