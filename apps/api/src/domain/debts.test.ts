import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { balanceOf, domainRejection, getTransactionRow, seedAccount, seedDebtPayment, seedTransaction, transactionRows } from "../../test/api";
import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { debtPayments, debts as debtsTable, transactions as transactionsTable } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as debts from "./debts";
import * as transactions from "./transactions";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

const seedDebt = (userId: string, overrides: Partial<debts.DebtFields> = {}) =>
  tx((t) => debts.createDebt(t, userId, { name: "Car loan", debtType: "loan", originalAmount: 10_000, currentBalance: 8_000, ...overrides }));

const debtRow = async (id: string) => (await testDb().select().from(debtsTable).where(eq(debtsTable.id, id)))[0];
const paymentRow = async (id: string) => (await testDb().select().from(debtPayments).where(eq(debtPayments.id, id)))[0];

const pay = (userId: string, args: Omit<debts.DebtPaymentFields, "date"> & { date?: string }) =>
  tx((t) => debts.recordDebtPayment(t, userId, { date: "2026-01-01", ...args }));

describe("domain/debts", () => {
  it("creates, lists, gets, updates, archives, restores and deletes for the given user", async () => {
    const alice = await createTestUser();
    const { id } = await seedDebt(alice, { lender: "Bank", interestRate: 5.5, minimumPayment: 200 });

    expect(await read((t) => debts.getDebt(t, alice, id))).toMatchObject({
      userId: alice,
      name: "Car loan",
      lender: "Bank",
      interestRate: 5.5,
      minimumPayment: 200,
      archived: false,
    });
    expect(await read((t) => debts.listDebts(t, alice))).toHaveLength(1);

    expect(await tx((t) => debts.updateDebt(t, alice, id, { currentBalance: 5_000 }))).toMatchObject({ currentBalance: 5_000, originalAmount: 10_000 });

    await tx((t) => debts.setDebtArchived(t, alice, id, true));
    expect(await read((t) => debts.listDebts(t, alice))).toHaveLength(0);
    expect(await read((t) => debts.listDebts(t, alice, { includeArchived: true }))).toHaveLength(1);
    await tx((t) => debts.setDebtArchived(t, alice, id, false));
    expect(await read((t) => debts.listDebts(t, alice))).toHaveLength(1);

    await tx((t) => debts.deleteDebt(t, alice, id));
    expect(await debtRow(id)).toBeUndefined();
  });

  it("validates amounts on create and against the stored ones on update", async () => {
    const alice = await createTestUser();
    expect(await domainRejection(seedDebt(alice, { originalAmount: 0, currentBalance: 0 }))).toEqual({
      code: "validation_failed",
      message: "Original amount must be positive",
    });
    expect(await domainRejection(seedDebt(alice, { currentBalance: -1 }))).toMatchObject({ message: "Current balance cannot be negative" });
    expect(await domainRejection(seedDebt(alice, { currentBalance: 10_001 }))).toMatchObject({
      message: "Current balance cannot exceed original amount",
    });
    const { id } = await seedDebt(alice);
    expect(await domainRejection(tx((t) => debts.updateDebt(t, alice, id, { originalAmount: 7_999 })))).toMatchObject({
      message: "Current balance cannot exceed original amount",
    });
    expect(await debtRow(id)).toMatchObject({ originalAmount: 10_000, currentBalance: 8_000 });
  });

  it("sorts open debts by due date, undated after dated, and paid-off debts last", async () => {
    const alice = await createTestUser();
    await seedDebt(alice, { name: "Completed later", currentBalance: 0, dueDate: "2026-12-01" });
    await seedDebt(alice, { name: "No due date" });
    await seedDebt(alice, { name: "Due soon", dueDate: "2026-04-01" });
    await seedDebt(alice, { name: "Completed sooner", currentBalance: 0, dueDate: "2026-03-01" });
    await seedDebt(alice, { name: "Due later", dueDate: "2026-09-01" });
    await seedDebt(alice, { name: "Also no due date" });

    expect((await read((t) => debts.listDebts(t, alice))).map((d) => d.name)).toEqual([
      "Due soon",
      "Due later",
      "No due date",
      "Also no due date",
      "Completed sooner",
      "Completed later",
    ]);
  });

  it("archives a legacy debt whose amounts no longer validate", async () => {
    const alice = await createTestUser();
    const { id } = await seedDebt(alice);
    await testDb().update(debtsTable).set({ currentBalance: 20_000 }).where(eq(debtsTable.id, id));
    expect(await tx((t) => debts.setDebtArchived(t, alice, id, true))).toMatchObject({ archived: true });
  });

  it("deletes the debt with its payments, their transactions and balance effects", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const liability = await seedAccount(alice, { type: "loan", balance: -8_000 });
    const { id } = await seedDebt(alice, { linkedAccountId: liability });
    await pay(alice, { debtId: id, amount: 1_500, principalAmount: 1_000, interestAmount: 500, fromAccountId: from });
    await pay(alice, { debtId: id, amount: 500, fromAccountId: from });

    await tx((t) => debts.deleteDebt(t, alice, id));
    expect(await balanceOf(from)).toBe(10_000);
    expect(await balanceOf(liability)).toBe(-8_000);
    expect(await transactionRows()).toEqual([]);
    expect(await testDb().select().from(debtPayments)).toEqual([]);
  });

  describe("cross-user ownership", () => {
    it("rejects every id-based operation from another user", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { id } = await seedDebt(alice);
      const ops: Array<(t: Tx) => Promise<unknown>> = [
        (t) => debts.getDebt(t, bob, id),
        (t) => debts.updateDebt(t, bob, id, { name: "x" }),
        (t) => debts.setDebtArchived(t, bob, id, true),
        (t) => debts.deleteDebt(t, bob, id),
      ];
      for (const op of ops) {
        expect(await domainRejection(tx(op))).toEqual({ code: "not_found", message: "Debt not found" });
      }
      expect(await debtRow(id)).toMatchObject({ userId: alice, name: "Car loan", archived: false });
      expect(await read((t) => debts.listDebts(t, bob))).toEqual([]);
    });

    it("rejects linking a debt to another user's account", async () => {
      const alice = await createTestUser();
      const theirs = await seedAccount(await createTestUser());
      expect(await domainRejection(seedDebt(alice, { linkedAccountId: theirs }))).toEqual({ code: "not_found", message: "Account not found" });
      const { id } = await seedDebt(alice);
      expect(await domainRejection(tx((t) => debts.updateDebt(t, alice, id, { linkedAccountId: theirs })))).toMatchObject({
        message: "Account not found",
      });
    });
  });
});

describe("domain/debts payments", () => {
  it("records a payment, updating balances, and removes it again", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const liability = await seedAccount(alice, { type: "loan", balance: -8_000 });
    const { id: debtId } = await seedDebt(alice, { linkedAccountId: liability });

    const payment = await pay(alice, { debtId, amount: 1_500, principalAmount: 1_000, interestAmount: 500, fromAccountId: from, note: "Jan" });
    expect(await balanceOf(from)).toBe(8_500);
    expect(await balanceOf(liability)).toBe(-9_000);
    expect(await debtRow(debtId)).toMatchObject({ currentBalance: 7_000 });
    expect(await getTransactionRow(payment.sourceTransactionId!)).toMatchObject({
      type: "expense",
      amount: 1_500,
      accountId: from,
      description: "Debt payment: Car loan",
      note: "Jan",
    });
    expect(await getTransactionRow(payment.liabilityTransactionId!)).toMatchObject({
      type: "adjustment",
      amount: -1_000,
      accountId: liability,
      description: "Debt principal payment: Car loan",
    });
    expect(await read((t) => debts.listDebtPayments(t, alice, debtId))).toHaveLength(1);

    await tx((t) => debts.removeDebtPayment(t, alice, payment.id));
    expect(await balanceOf(from)).toBe(10_000);
    expect(await balanceOf(liability)).toBe(-8_000);
    expect(await debtRow(debtId)).toMatchObject({ currentBalance: 8_000 });
    expect(await paymentRow(payment.id)).toBeUndefined();
    expect(await transactionRows()).toEqual([]);
  });

  it("defaults the principal to the amount; interest-only payments leave the balance and the linked account alone", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const liability = await seedAccount(alice, { type: "loan", balance: -8_000 });
    const { id: debtId } = await seedDebt(alice, { linkedAccountId: liability });

    expect(await pay(alice, { debtId, amount: 500, fromAccountId: from })).toMatchObject({ principalAmount: 500, interestAmount: 0 });
    const interestOnly = await pay(alice, { debtId, amount: 300, principalAmount: 0, interestAmount: 300, fromAccountId: from });
    expect(interestOnly.liabilityTransactionId).toBeNull();
    expect(await debtRow(debtId)).toMatchObject({ currentBalance: 7_500 });
    expect(await balanceOf(liability)).toBe(-8_500);
    expect(await balanceOf(from)).toBe(9_200);
  });

  it("validates payment amounts", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice);
    const { id: debtId } = await seedDebt(alice);
    const base = { debtId, fromAccountId: from };

    expect(await domainRejection(pay(alice, { ...base, amount: 0 }))).toEqual({ code: "validation_failed", message: "Amount must be positive" });
    expect(await domainRejection(pay(alice, { ...base, amount: 100, principalAmount: 50 }))).toMatchObject({
      message: "Principal and interest must add up to the payment amount",
    });
    expect(await domainRejection(pay(alice, { ...base, amount: 100, principalAmount: -50, interestAmount: 150 }))).toMatchObject({
      message: "Principal and interest cannot be negative",
    });
    expect(await domainRejection(pay(alice, { ...base, amount: 9_000 }))).toMatchObject({
      message: "Principal amount cannot exceed the remaining balance",
    });
    expect(await transactionRows()).toEqual([]);
  });

  it("refuses plain update and delete of the payment's source and liability transactions", async () => {
    const alice = await createTestUser();
    const from = await seedAccount(alice, { balance: 10_000 });
    const liability = await seedAccount(alice, { type: "loan", balance: -8_000 });
    const { id: debtId } = await seedDebt(alice, { linkedAccountId: liability });
    const payment = await pay(alice, { debtId, amount: 1_000, fromAccountId: from });
    for (const id of [payment.sourceTransactionId!, payment.liabilityTransactionId!]) {
      expect(await domainRejection(tx((t) => transactions.deleteTransaction(t, alice, id)))).toMatchObject({ code: "conflict" });
      expect(await domainRejection(tx((t) => transactions.updateTransaction(t, alice, id, { note: "x" })))).toMatchObject({ code: "conflict" });
    }
    expect(await balanceOf(from)).toBe(9_000);
    expect(await balanceOf(liability)).toBe(-9_000);
  });

  describe("legacy rows", () => {
    it("removes a payment whose paying account is gone: its row is deleted without a balance effect", async () => {
      const alice = await createTestUser();
      const { id: debtId } = await seedDebt(alice, { currentBalance: 7_500 });
      const payment = await seedDebtPayment(alice, { debtId, fromAccountId: null, amount: 500 });

      expect((await read((t) => debts.listDebtPayments(t, alice, debtId)))[0]).toMatchObject({ fromAccountId: null });
      await tx((t) => debts.removeDebtPayment(t, alice, payment.id));
      expect(await debtRow(debtId)).toMatchObject({ currentBalance: 8_000 });
      expect(await transactionRows()).toEqual([]);
    });

    it("removes a payment whose source transaction is gone", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 9_500 });
      const { id: debtId } = await seedDebt(alice, { currentBalance: 7_500 });
      const payment = await seedDebtPayment(alice, { debtId, fromAccountId: from, amount: 500 });
      await testDb().update(debtPayments).set({ sourceTransactionId: null }).where(eq(debtPayments.id, payment.id));
      await testDb().delete(transactionsTable).where(eq(transactionsTable.id, payment.sourceTransactionId));

      await tx((t) => debts.removeDebtPayment(t, alice, payment.id));
      expect(await balanceOf(from)).toBe(9_500);
      expect(await debtRow(debtId)).toMatchObject({ currentBalance: 8_000 });
      expect(await paymentRow(payment.id)).toBeUndefined();
    });

    it("deletes a debt whose payments mix live and orphaned rows", async () => {
      const alice = await createTestUser();
      const from = await seedAccount(alice, { balance: 9_000 });
      const { id: debtId } = await seedDebt(alice, { currentBalance: 7_000 });
      await seedDebtPayment(alice, { debtId, fromAccountId: from, amount: 500 });
      await seedDebtPayment(alice, { debtId, fromAccountId: null, amount: 500 });
      // A row with no account left (Convex deleted it) next to the live ones.
      await seedTransaction(alice, null, { type: "expense", amount: 1 });

      await tx((t) => debts.deleteDebt(t, alice, debtId));
      expect(await balanceOf(from)).toBe(9_500);
      expect(await transactionRows()).toHaveLength(1);
      expect(await debtRow(debtId)).toBeUndefined();
    });
  });

  describe("cross-user ownership", () => {
    it("rejects paying or listing another user's debt, and paying from another user's account", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const { id: debtId } = await seedDebt(alice);
      const bobAccount = await seedAccount(bob, { balance: 10_000 });

      expect(await domainRejection(pay(bob, { debtId, amount: 100, fromAccountId: bobAccount }))).toEqual({
        code: "not_found",
        message: "Debt not found",
      });
      expect(await domainRejection(read((t) => debts.listDebtPayments(t, bob, debtId)))).toMatchObject({ message: "Debt not found" });
      expect(await domainRejection(pay(alice, { debtId, amount: 100, fromAccountId: bobAccount }))).toEqual({
        code: "not_found",
        message: "Account not found",
      });
      expect(await balanceOf(bobAccount)).toBe(10_000);
    });

    it("rejects removing another user's payment", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const from = await seedAccount(alice, { balance: 10_000 });
      const { id: debtId } = await seedDebt(alice);
      const payment = await pay(alice, { debtId, amount: 100, fromAccountId: from });
      expect(await domainRejection(tx((t) => debts.removeDebtPayment(t, bob, payment.id)))).toEqual({
        code: "not_found",
        message: "Debt payment not found",
      });
      expect(await paymentRow(payment.id)).toBeDefined();
      expect(await balanceOf(from)).toBe(9_900);
    });
  });
});
