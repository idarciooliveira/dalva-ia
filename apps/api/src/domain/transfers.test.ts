import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getAccountRow, getTransactionRow, seedAccount, seedContribution, seedTransaction } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { transactions } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import { DomainError } from "./errors";
import * as transfers from "./transfers";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const balanceOf = async (id: string) => (await getAccountRow(id))?.balance;

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return { code: (error as DomainError).code, message: (error as DomainError).message };
}

async function seedTransfer(userId: string, from: string, to: string, amount = 1_000) {
  const outgoing = await tx((t) =>
    transfers.createTransfer(t, userId, { amount, fromAccountId: from, toAccountId: to, date: "2026-03-10", description: "Move" }),
  );
  const incoming = (await getTransactionRow(outgoing))!.linkedTransactionId!;
  return { outgoing, incoming };
}

describe("domain/transfers", () => {
  it("creates two linked transactions and moves balances", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000, name: "From" });
    const to = await seedAccount(alice, { balance: 500, name: "To" });
    const { outgoing, incoming } = await seedTransfer(alice, from, to);

    expect(await balanceOf(from)).toBe(9_000);
    expect(await balanceOf(to)).toBe(1_500);
    const out = await getTransactionRow(outgoing);
    const inc = await getTransactionRow(incoming);
    expect(out).toMatchObject({
      userId: alice,
      type: "transfer",
      amount: 1_000,
      accountId: from,
      destinationAccountId: to,
      linkedTransactionId: incoming,
      description: "Move",
    });
    expect(inc).toMatchObject({ type: "transfer", accountId: to, linkedTransactionId: outgoing, destinationAccountId: null });
    expect(out!.transferGroupId).toBeTruthy();
    expect(inc!.transferGroupId).toBe(out!.transferGroupId);
  });

  it("validates amount, distinct accounts and one currency", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice);
    const to = await seedAccount(alice);
    const eur = await seedAccount(alice, { currency: "EUR" });
    const create = (amount: number, fromAccountId: string, toAccountId: string) =>
      tx((t) => transfers.createTransfer(t, alice, { amount, fromAccountId, toAccountId, date: "2026-03-10" }));
    for (const amount of [0, -1, 1.5]) {
      expect(await rejection(create(amount, from, to))).toEqual({ code: "validation_failed", message: "Amount must be positive" });
    }
    expect(await rejection(create(1, from, from))).toEqual({ code: "validation_failed", message: "Cannot transfer to the same account" });
    expect(await rejection(create(1, from, eur))).toMatchObject({ code: "validation_failed", message: expect.stringContaining("Cross-currency") });
    expect(await testDb().select().from(transactions)).toEqual([]);
  });

  it("getTransfer resolves either leg with both accounts", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000, name: "From" });
    const to = await seedAccount(alice, { name: "To" });
    const { outgoing, incoming } = await seedTransfer(alice, from, to, 700);
    for (const id of [outgoing, incoming]) {
      const transfer = await readTx(testDb(), (t) => transfers.getTransfer(t, alice, id));
      expect(transfer.outgoing).toMatchObject({ id: outgoing, amount: 700, description: "Move" });
      expect(transfer.incoming.id).toBe(incoming);
      expect(transfer.fromAccount?.name).toBe("From");
      expect(transfer.toAccount?.name).toBe("To");
    }
    const plain = await seedTransaction(alice, from);
    expect(await rejection(readTx(testDb(), (t) => transfers.getTransfer(t, alice, plain)))).toEqual({
      code: "not_found",
      message: "Transfer not found",
    });
  });

  it("updateTransfer re-balances accounts and updates both legs", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const to = await seedAccount(alice);
    const other = await seedAccount(alice);
    const { outgoing, incoming } = await seedTransfer(alice, from, to);

    await tx((t) => transfers.updateTransfer(t, alice, incoming, { amount: 400, toAccountId: other, note: "n", date: "2026-03-12" }));
    expect(await balanceOf(from)).toBe(9_600);
    expect(await balanceOf(to)).toBe(0);
    expect(await balanceOf(other)).toBe(400);
    expect(await getTransactionRow(outgoing)).toMatchObject({ amount: 400, destinationAccountId: other, note: "n", date: "2026-03-12", description: "Move" });
    expect(await getTransactionRow(incoming)).toMatchObject({ amount: 400, accountId: other, note: "n", date: "2026-03-12" });

    expect(await rejection(tx((t) => transfers.updateTransfer(t, alice, outgoing, { toAccountId: from })))).toMatchObject({
      message: "Cannot transfer to the same account",
    });
  });

  it("swaps source and destination", async () => {
    const alice = await createTestUser();
    const checking = await seedAccount(alice, { balance: 100_000 });
    const savings = await seedAccount(alice, { balance: 50_000 });
    const { outgoing } = await seedTransfer(alice, checking, savings, 20_000);
    await tx((t) => transfers.updateTransfer(t, alice, outgoing, { fromAccountId: savings, toAccountId: checking }));
    expect(await balanceOf(checking)).toBe(120_000);
    expect(await balanceOf(savings)).toBe(30_000);
  });

  it("deleteTransfer removes both legs and reverses balances, from either leg", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const to = await seedAccount(alice);
    for (const pick of ["outgoing", "incoming"] as const) {
      const legs = await seedTransfer(alice, from, to);
      await tx((t) => transfers.deleteTransfer(t, alice, legs[pick]));
      expect(await balanceOf(from)).toBe(10_000);
      expect(await balanceOf(to)).toBe(0);
      expect(await getTransactionRow(legs.outgoing)).toBeUndefined();
      expect(await getTransactionRow(legs.incoming)).toBeUndefined();
    }
  });

  describe("legacy legs", () => {
    it("deletes a leg whose pair is gone alone, reversing its own effect", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice, { balance: 5_000 });
      const lonelyOutgoing = await seedTransaction(alice, from, { type: "transfer", amount: 300, destinationAccountId: to });
      const lonelyIncoming = await seedTransaction(alice, to, { type: "transfer", amount: 200 });
      await tx((t) => transfers.deleteTransfer(t, alice, lonelyOutgoing));
      await tx((t) => transfers.deleteTransfer(t, alice, lonelyIncoming));
      // The outgoing leg had debited `from`, the incoming one had credited `to`.
      expect(await balanceOf(from)).toBe(10_300);
      expect(await balanceOf(to)).toBe(4_800);
    });

    it("refuses to read or update a leg whose pair is gone, and skips legs without an account", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const lonely = await seedTransaction(alice, from, { type: "transfer", amount: 300 });
      expect(await rejection(readTx(testDb(), (t) => transfers.getTransfer(t, alice, lonely)))).toMatchObject({ code: "not_found" });
      expect(await rejection(tx((t) => transfers.updateTransfer(t, alice, lonely, { note: "x" })))).toMatchObject({ code: "not_found" });

      const { outgoing, incoming } = await seedTransfer(alice, from, await seedAccount(alice), 1_000);
      await testDb().update(transactions).set({ accountId: null }).where(eq(transactions.id, incoming));
      const view = await readTx(testDb(), (t) => transfers.getTransfer(t, alice, outgoing));
      expect(view.toAccount).toBeNull();
      // The orphaned leg has no account: moving the transfer needs a destination.
      expect(await rejection(tx((t) => transfers.updateTransfer(t, alice, outgoing, { amount: 10 })))).toEqual({
        code: "not_found",
        message: "Account not found",
      });
      await tx((t) => transfers.deleteTransfer(t, alice, outgoing));
      expect(await balanceOf(from)).toBe(10_000);
    });
  });

  it("refuses to change a goal contribution's transfer through either leg", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const goalAccount = await seedAccount(alice);
    const { outgoing, incoming } = await seedTransfer(alice, from, goalAccount, 500);
    await seedContribution(alice, outgoing, goalAccount);
    for (const id of [outgoing, incoming]) {
      expect(await rejection(tx((t) => transfers.updateTransfer(t, alice, id, { note: "x" })))).toEqual({
        code: "conflict",
        message: transfers.CONTRIBUTION_MANAGED_MESSAGE,
      });
      expect(await rejection(tx((t) => transfers.deleteTransfer(t, alice, id)))).toMatchObject({ code: "conflict" });
    }
    // Reading it is fine.
    expect((await readTx(testDb(), (t) => transfers.getTransfer(t, alice, incoming))).outgoing.id).toBe(outgoing);
    expect(await balanceOf(from)).toBe(9_500);
  });

  describe("cross-user ownership", () => {
    it("rejects foreign accounts on create", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const mine = await seedAccount(alice, { balance: 10_000 });
      const theirs = await seedAccount(bob, { balance: 10_000 });
      for (const [fromAccountId, toAccountId] of [[theirs, mine], [mine, theirs]] as const) {
        expect(await rejection(tx((t) => transfers.createTransfer(t, alice, { amount: 100, fromAccountId, toAccountId, date: "2026-03-10" })))).toEqual({
          code: "not_found",
          message: "Account not found",
        });
      }
      expect(await balanceOf(mine)).toBe(10_000);
      expect(await balanceOf(theirs)).toBe(10_000);
    });

    it("rejects get/update/delete of another user's transfer, and moving one to a foreign account", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice);
      const theirs = await seedAccount(bob);
      const { outgoing } = await seedTransfer(alice, from, to);

      expect(await rejection(readTx(testDb(), (t) => transfers.getTransfer(t, bob, outgoing)))).toEqual({ code: "not_found", message: "Transfer not found" });
      expect(await rejection(tx((t) => transfers.updateTransfer(t, bob, outgoing, { amount: 1 })))).toMatchObject({ code: "not_found" });
      expect(await rejection(tx((t) => transfers.deleteTransfer(t, bob, outgoing)))).toMatchObject({ code: "not_found" });
      for (const change of [{ toAccountId: theirs }, { fromAccountId: theirs }]) {
        expect(await rejection(tx((t) => transfers.updateTransfer(t, alice, outgoing, change)))).toEqual({
          code: "not_found",
          message: "Account not found",
        });
      }
      expect(await balanceOf(from)).toBe(9_000);
    });
  });
});
