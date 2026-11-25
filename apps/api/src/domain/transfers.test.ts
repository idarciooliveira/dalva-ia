import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { balanceOf, domainRejection, getTransactionRow, seedAccount, seedContribution, seedTransaction } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { transactions } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import { MANAGED_MESSAGES } from "./ledger";
import * as transfers from "./transfers";

// Balance math, legacy legs and owners are the ledger's (ledger.test.ts). These cover the transfer API over it.

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

async function seedTransfer(userId: string, from: string, to: string, amount = 1_000) {
  const outgoing = await tx((t) =>
    transfers.createTransfer(t, userId, { amount: usd(amount), fromAccountId: from, toAccountId: to, date: "2026-03-10", description: "Move" }),
  );
  const incoming = (await getTransactionRow(outgoing))!.linkedTransactionId!;
  return { outgoing, incoming };
}

describe("domain/transfers", () => {
  it("creates a transfer and returns its outgoing leg", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000, name: "From" });
    const to = await seedAccount(alice, { balance: 500, name: "To" });
    const { outgoing, incoming } = await seedTransfer(alice, from, to);

    expect(await getTransactionRow(outgoing)).toMatchObject({ accountId: from, destinationAccountId: to, linkedTransactionId: incoming });
    expect([await balanceOf(from), await balanceOf(to)]).toEqual([9_000, 1_500]);
  });

  it("getTransfer resolves either leg with both accounts", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000, name: "From" });
    const to = await seedAccount(alice, { name: "To" });
    const { outgoing, incoming } = await seedTransfer(alice, from, to, 700);
    for (const id of [outgoing, incoming]) {
      const transfer = await read((t) => transfers.getTransfer(t, alice, id));
      expect(transfer.outgoing).toMatchObject({ id: outgoing, amount: 700, description: "Move" });
      expect(transfer.incoming.id).toBe(incoming);
      expect(transfer.fromAccount?.name).toBe("From");
      expect(transfer.toAccount?.name).toBe("To");
    }
    const plain = await seedTransaction(alice, from);
    expect(await domainRejection(read((t) => transfers.getTransfer(t, alice, plain)))).toEqual({
      code: "not_found",
      message: "Transfer not found",
    });
  });

  it("updateTransfer and deleteTransfer work from either leg", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const to = await seedAccount(alice);
    const other = await seedAccount(alice);
    const { outgoing, incoming } = await seedTransfer(alice, from, to);

    expect(await tx((t) => transfers.updateTransfer(t, alice, incoming, { amount: usd(400), toAccountId: other, note: "n" }))).toBe(outgoing);
    expect([await balanceOf(from), await balanceOf(to), await balanceOf(other)]).toEqual([9_600, 0, 400]);
    expect(await getTransactionRow(incoming)).toMatchObject({ amount: 400, accountId: other, note: "n" });

    await tx((t) => transfers.deleteTransfer(t, alice, incoming));
    expect([await balanceOf(from), await balanceOf(other)]).toEqual([10_000, 0]);
    expect(await getTransactionRow(outgoing)).toBeUndefined();
  });

  describe("legacy legs", () => {
    it("refuses to read or update a leg whose pair is gone, and reads a leg without an account", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const lonely = await seedTransaction(alice, from, { type: "transfer", amount: 300 });
      expect(await domainRejection(read((t) => transfers.getTransfer(t, alice, lonely)))).toMatchObject({ code: "not_found" });
      expect(await domainRejection(tx((t) => transfers.updateTransfer(t, alice, lonely, { note: "x" })))).toMatchObject({ code: "not_found" });

      const { outgoing, incoming } = await seedTransfer(alice, from, await seedAccount(alice), 1_000);
      await testDb().update(transactions).set({ accountId: null }).where(eq(transactions.id, incoming));
      const view = await read((t) => transfers.getTransfer(t, alice, outgoing));
      expect(view.toAccount).toBeNull();
    });
  });

  it("refuses to change a goal contribution's transfer through either leg, but reads it", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const goalAccount = await seedAccount(alice);
    const { outgoing, incoming } = await seedTransfer(alice, from, goalAccount, 500);
    await seedContribution(alice, outgoing, goalAccount);
    for (const id of [outgoing, incoming]) {
      expect(await domainRejection(tx((t) => transfers.updateTransfer(t, alice, id, { note: "x" })))).toEqual({
        code: "conflict",
        message: MANAGED_MESSAGES.goal_contribution,
      });
      expect(await domainRejection(tx((t) => transfers.deleteTransfer(t, alice, id)))).toMatchObject({ code: "conflict" });
    }
    expect((await read((t) => transfers.getTransfer(t, alice, incoming))).outgoing.id).toBe(outgoing);
    expect(await balanceOf(from)).toBe(9_500);
  });

  describe("cross-user ownership", () => {
    it("rejects get/update/delete of another user's transfer", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const to = await seedAccount(alice);
      const { outgoing } = await seedTransfer(alice, from, to);

      expect(await domainRejection(read((t) => transfers.getTransfer(t, bob, outgoing)))).toEqual({ code: "not_found", message: "Transfer not found" });
      expect(await domainRejection(tx((t) => transfers.updateTransfer(t, bob, outgoing, { amount: usd(1) })))).toMatchObject({ code: "not_found" });
      expect(await domainRejection(tx((t) => transfers.deleteTransfer(t, bob, outgoing)))).toMatchObject({ code: "not_found" });
      expect(await balanceOf(from)).toBe(9_000);
    });
  });
});
