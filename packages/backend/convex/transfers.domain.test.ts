import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel";
import * as accounts from "./domain/accounts";
import * as transfers from "./domain/transfers";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedAccount(t: T, userId: string, balance = 10000, name = "Acct") {
  return await t.run((ctx) =>
    accounts.createAccount(ctx, userId, { name, type: "bank", balance, currency: "USD" }),
  );
}

async function balanceOf(t: T, id: Id<"accounts">) {
  return (await t.run((ctx) => ctx.db.get(id)))?.balance;
}

async function seedTransfer(t: T, userId: string, from: Id<"accounts">, to: Id<"accounts">, amount = 1000) {
  return await t.run((ctx) =>
    transfers.createTransfer(ctx, userId, {
      amount,
      fromAccountId: from,
      toAccountId: to,
      date: "2026-03-10",
      description: "Move",
    }),
  );
}

describe("domain/transfers", () => {
  it("creates two linked transactions and moves balances", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000, "From");
    const to = await seedAccount(t, ALICE, 500, "To");
    const { outgoingId, incomingId, transferGroupId } = await seedTransfer(t, ALICE, from, to);

    expect(await balanceOf(t, from)).toBe(9000);
    expect(await balanceOf(t, to)).toBe(1500);
    const [out, inc] = await t.run(async (ctx) => [await ctx.db.get(outgoingId), await ctx.db.get(incomingId)]);
    expect(out).toMatchObject({
      userId: ALICE,
      type: "transfer",
      accountId: from,
      destinationAccountId: to,
      transferGroupId,
      linkedTransactionId: incomingId,
    });
    expect(inc).toMatchObject({
      accountId: to,
      transferGroupId,
      linkedTransactionId: outgoingId,
    });
    expect(inc?.destinationAccountId).toBeUndefined();
  });

  it("validates amount and distinct accounts", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE);
    const to = await seedAccount(t, ALICE);
    await expect(
      t.run((ctx) =>
        transfers.createTransfer(ctx, ALICE, {
          amount: 0, fromAccountId: from, toAccountId: to, date: "2026-03-10",
        }),
      ),
    ).rejects.toThrow("Amount must be positive");
    await expect(
      t.run((ctx) =>
        transfers.createTransfer(ctx, ALICE, {
          amount: 1, fromAccountId: from, toAccountId: from, date: "2026-03-10",
        }),
      ),
    ).rejects.toThrow("Cannot transfer to the same account");
  });

  it("getTransfer resolves either side with account names", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000, "From");
    const to = await seedAccount(t, ALICE, 0, "To");
    const { outgoingId, incomingId } = await seedTransfer(t, ALICE, from, to, 700);
    for (const id of [outgoingId, incomingId]) {
      expect(await t.run((ctx) => transfers.getTransfer(ctx, ALICE, { id }))).toMatchObject({
        outgoingId,
        incomingId,
        amount: 700,
        fromAccountName: "From",
        toAccountName: "To",
        description: "Move",
      });
    }
  });

  it("updateTransfer re-balances accounts and updates both sides", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000);
    const to = await seedAccount(t, ALICE, 0);
    const other = await seedAccount(t, ALICE, 0);
    const { outgoingId, incomingId } = await seedTransfer(t, ALICE, from, to, 1000);

    await t.run((ctx) =>
      transfers.updateTransfer(ctx, ALICE, { id: incomingId, amount: 400, toAccountId: other, note: "n" }),
    );
    expect(await balanceOf(t, from)).toBe(9600);
    expect(await balanceOf(t, to)).toBe(0);
    expect(await balanceOf(t, other)).toBe(400);
    const [out, inc] = await t.run(async (ctx) => [await ctx.db.get(outgoingId), await ctx.db.get(incomingId)]);
    expect(out).toMatchObject({ amount: 400, destinationAccountId: other, note: "n" });
    expect(inc).toMatchObject({ amount: 400, accountId: other, note: "n" });

    await expect(
      t.run((ctx) => transfers.updateTransfer(ctx, ALICE, { id: outgoingId, toAccountId: from })),
    ).rejects.toThrow("Cannot transfer to the same account");
  });

  it("deleteTransfer removes both sides and reverses balances", async () => {
    const t = setupTest();
    const from = await seedAccount(t, ALICE, 10000);
    const to = await seedAccount(t, ALICE, 0);
    const { outgoingId, incomingId } = await seedTransfer(t, ALICE, from, to, 1000);
    await t.run((ctx) => transfers.deleteTransfer(ctx, ALICE, { id: incomingId }));
    expect(await balanceOf(t, from)).toBe(10000);
    expect(await balanceOf(t, to)).toBe(0);
    expect(await t.run((ctx) => ctx.db.get(outgoingId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(incomingId))).toBeNull();
  });

  describe("cross-user ownership", () => {
    it("rejects foreign accounts on create", async () => {
      const t = setupTest();
      const mine = await seedAccount(t, ALICE);
      const theirs = await seedAccount(t, BOB);
      const pairs: Array<[Id<"accounts">, Id<"accounts">]> = [[theirs, mine], [mine, theirs]];
      for (const [fromAccountId, toAccountId] of pairs) {
        await expect(
          t.run((ctx) =>
            transfers.createTransfer(ctx, ALICE, {
              amount: 100, fromAccountId, toAccountId, date: "2026-03-10",
            }),
          ),
        ).rejects.toThrow("Account not found");
      }
      expect(await balanceOf(t, mine)).toBe(10000);
      expect(await balanceOf(t, theirs)).toBe(10000);
    });

    it("rejects get/update/delete of another user's transfer", async () => {
      const t = setupTest();
      const from = await seedAccount(t, ALICE);
      const to = await seedAccount(t, ALICE);
      const { outgoingId } = await seedTransfer(t, ALICE, from, to);

      expect(await t.run((ctx) => transfers.getTransfer(ctx, BOB, { id: outgoingId }))).toBeNull();
      await expect(
        t.run((ctx) => transfers.updateTransfer(ctx, BOB, { id: outgoingId, amount: 1 })),
      ).rejects.toThrow("Transaction not found");
      await expect(
        t.run((ctx) => transfers.deleteTransfer(ctx, BOB, { id: outgoingId })),
      ).rejects.toThrow("Transaction not found");
      expect(await balanceOf(t, from)).toBe(9000);
    });

    it("rejects updating a transfer to a foreign account", async () => {
      const t = setupTest();
      const from = await seedAccount(t, ALICE);
      const to = await seedAccount(t, ALICE);
      const theirs = await seedAccount(t, BOB);
      const { outgoingId } = await seedTransfer(t, ALICE, from, to);
      await expect(
        t.run((ctx) => transfers.updateTransfer(ctx, ALICE, { id: outgoingId, toAccountId: theirs })),
      ).rejects.toThrow("Account not found");
      await expect(
        t.run((ctx) => transfers.updateTransfer(ctx, ALICE, { id: outgoingId, fromAccountId: theirs })),
      ).rejects.toThrow("Account not found");
    });
  });
});
