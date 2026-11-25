import { describe, expect, it } from "vitest";

import { getAccountRow } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { debtPayments, debts, savingsGoals, transactions } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as accounts from "./accounts";
import { DomainError } from "./errors";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

async function seedAccount(userId: string, overrides: Partial<Parameters<typeof accounts.createAccount>[2]> = {}) {
  const account = await tx((t) => accounts.createAccount(t, userId, { name: "Checking", type: "bank", balance: usd(10_000), ...overrides }));
  return account.id;
}


describe("domain/accounts", () => {
  it("creates and lists accounts for an explicit user id", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await seedAccount(alice, { name: "Alice", theme: "forest" });
    await seedAccount(bob, { name: "Bob" });

    const aliceAccounts = await readTx(testDb(), (t) => accounts.listAccounts(t, alice, {}));
    expect(aliceAccounts).toHaveLength(1);
    expect(aliceAccounts[0]).toMatchObject({ userId: alice, name: "Alice", theme: "forest", balance: 10_000 });
  });

  it("lists oldest first, also within one transaction", async () => {
    const user = await createTestUser();
    const ids = await tx(async (t) => {
      const out = [];
      for (const name of ["a", "b", "c"]) out.push((await accounts.createAccount(t, user, { name, type: "bank", balance: usd(0) })).id);
      return out;
    });
    expect((await readTx(testDb(), (t) => accounts.listAccounts(t, user))).map((a) => a.id)).toEqual(ids);
  });

  it("excludes archived accounts unless includeArchived is set", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user);
    await tx((t) => accounts.updateAccount(t, user, id, { archived: true }));

    expect(await readTx(testDb(), (t) => accounts.listAccounts(t, user, {}))).toEqual([]);
    expect(await readTx(testDb(), (t) => accounts.listAccounts(t, user, { includeArchived: true }))).toHaveLength(1);

    await tx((t) => accounts.updateAccount(t, user, id, { archived: false }));
    expect(await readTx(testDb(), (t) => accounts.listAccounts(t, user, {}))).toHaveLength(1);
  });

  it("updates only provided fields", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user, { theme: "azul" });
    await tx((t) => accounts.updateAccount(t, user, id, { name: "Renamed", icon: undefined }));
    expect(await getAccountRow(id)).toMatchObject({ name: "Renamed", type: "bank", theme: "azul", icon: null });
  });

  it("adjustBalance records an adjustment transaction and updates the balance", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user);
    const updated = await tx((t) => accounts.adjustBalance(t, user, { id, amount: usd(-2_500), date: "2026-01-02", note: "fix" }));
    expect(updated.balance).toBe(7_500);
    expect((await getAccountRow(id))?.balance).toBe(7_500);
    const txs = await testDb().select().from(transactions);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      userId: user,
      accountId: id,
      type: "adjustment",
      amount: -2_500,
      date: "2026-01-02",
      description: "Balance adjustment",
      note: "fix",
    });
  });

  it("adjustBalance refuses a balance past the safe integer range and rolls back", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user, { balance: usd(Number.MAX_SAFE_INTEGER - 1) });
    await expect(tx((t) => accounts.adjustBalance(t, user, { id, amount: usd(10), date: "2026-01-02" }))).rejects.toThrow(
      "Balance out of range",
    );
    expect((await getAccountRow(id))?.balance).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(await testDb().select().from(transactions)).toEqual([]);
  });

  it("deletes an account", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user);
    await tx((t) => accounts.deleteAccount(t, user, id));
    expect(await getAccountRow(id)).toBeUndefined();
  });

  it("refuses to delete an account that transactions reference", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user);
    await testDb().insert(transactions).values({ userId: user, type: "expense", amount: 100, accountId: id, date: "2026-01-01" });
    const error = await tx((t) => accounts.deleteAccount(t, user, id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "conflict", message: expect.stringMatching(/archive/i) });
    expect(await getAccountRow(id)).toBeDefined();
  });

  it("refuses to delete the destination of a transfer leg", async () => {
    const user = await createTestUser();
    const from = await seedAccount(user);
    const to = await seedAccount(user);
    await testDb()
      .insert(transactions)
      .values({ userId: user, type: "transfer", amount: 100, accountId: from, destinationAccountId: to, date: "2026-01-01" });
    await expect(tx((t) => accounts.deleteAccount(t, user, to))).rejects.toThrow(/archive/i);
  });

  it("refuses to delete an account a debt payment was made from", async () => {
    const user = await createTestUser();
    const id = await seedAccount(user);
    const [debt] = await testDb()
      .insert(debts)
      .values({ userId: user, name: "d", debtType: "loan", originalAmount: 100, currentBalance: 100 })
      .returning();
    // A legacy payment whose source transaction is gone still references the account.
    await testDb()
      .insert(debtPayments)
      .values({ userId: user, debtId: debt!.id, amount: 10, principalAmount: 10, interestAmount: 0, date: "2026-01-01", fromAccountId: id });
    await expect(tx((t) => accounts.deleteAccount(t, user, id))).rejects.toThrow(/archive/i);
  });

  it("refuses to delete an account linked to a goal or a debt", async () => {
    const user = await createTestUser();
    const goalAcc = await seedAccount(user);
    const debtAcc = await seedAccount(user);
    await testDb().insert(savingsGoals).values({ userId: user, name: "g", targetAmount: 100, isVirtual: false, linkedAccountId: goalAcc });
    await testDb()
      .insert(debts)
      .values({ userId: user, name: "d", debtType: "loan", originalAmount: 100, currentBalance: 100, linkedAccountId: debtAcc });
    await expect(tx((t) => accounts.deleteAccount(t, user, goalAcc))).rejects.toThrow(/archive/i);
    await expect(tx((t) => accounts.deleteAccount(t, user, debtAcc))).rejects.toThrow(/archive/i);
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const id = await seedAccount(alice);

      const ops: Array<(t: Tx) => Promise<unknown>> = [
        (t) => accounts.getAccount(t, bob, id),
        (t) => accounts.updateAccount(t, bob, id, { name: "x" }),
        (t) => accounts.updateAccount(t, bob, id, {}),
        (t) => accounts.updateAccount(t, bob, id, { archived: true }),
        (t) => accounts.deleteAccount(t, bob, id),
        (t) => accounts.adjustBalance(t, bob, { id, amount: usd(1), date: "2026-01-01" }),
      ];
      for (const op of ops) {
        await expect(tx(op)).rejects.toThrow("Account not found");
      }

      expect(await getAccountRow(id)).toMatchObject({ userId: alice, name: "Checking", balance: 10_000, archived: false });
      expect(await testDb().select().from(transactions)).toEqual([]);
      expect(await readTx(testDb(), (t) => accounts.listAccounts(t, bob, {}))).toEqual([]);
    });
  });
});
