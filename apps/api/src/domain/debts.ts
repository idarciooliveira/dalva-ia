/**
 * Debts and debt payments. Every function takes the
 * caller's user id and only touches that user's rows; missing and foreign
 * rows are both "not found". Amounts are stored minor units (value × 100), in
 * the user's base currency.
 *
 * A payment is an `expense` on the paying account ("Debt payment: <debt>")
 * and, when the debt has a linked account and the principal is positive, an
 * `adjustment` of minus the principal on it ("Debt principal payment:
 * <debt>"). The principal comes off `current_balance`. The transaction
 * endpoints refuse to change those rows; removing the payment (or deleting
 * the debt) deletes them and reverses their balance effects.
 *
 * Legacy payments (see the schema header) may have a null `from_account_id`
 * or `source_transaction_id`, and their rows a null `account_id`: whatever is
 * gone is skipped.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { debtPayments, debts, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { getAccount } from "./accounts";
import { invalid, notFound } from "./errors";
import { createTransaction, deleteTransactionRows, type Transaction } from "./transactions";

export type Debt = typeof debts.$inferSelect;
export type DebtType = Debt["debtType"];
export type DebtPayment = typeof debtPayments.$inferSelect;

/** Convex read at most this many debts per user, and payments per debt. */
const DEBTS_LIMIT = 100;
const PAYMENTS_LIMIT = 500;

const ownedDebt = (userId: string, id: string) => and(eq(debts.id, id), eq(debts.userId, userId));

/* Debts -------------------------------------------------------------------- */

/**
 * The user's debts, archived ones only with `includeArchived`. Open debts
 * first, paid-off ones last; within each, by due date with undated debts
 * after dated ones, then oldest first.
 */
export async function listDebts(tx: Tx, userId: string, args: { includeArchived?: boolean } = {}): Promise<Debt[]> {
  return await tx
    .select()
    .from(debts)
    .where(and(eq(debts.userId, userId), args.includeArchived ? undefined : eq(debts.archived, false)))
    .orderBy(
      sql`${debts.currentBalance} = 0`,
      sql`${debts.dueDate} asc nulls last`,
      asc(debts.createdOn),
      asc(debts.createdAt),
      asc(debts.id),
    )
    .limit(DEBTS_LIMIT);
}

export async function getDebt(tx: Tx, userId: string, id: string): Promise<Debt> {
  const [debt] = await tx.select().from(debts).where(ownedDebt(userId, id)).limit(1);
  if (!debt) throw notFound("Debt");
  return debt;
}

function assertAmounts(originalAmount: number, currentBalance: number) {
  if (!Number.isSafeInteger(originalAmount) || originalAmount <= 0) {
    throw invalid("originalAmount", "Original amount must be positive");
  }
  if (!Number.isSafeInteger(currentBalance) || currentBalance < 0) {
    throw invalid("currentBalance", "Current balance cannot be negative");
  }
  if (currentBalance > originalAmount) throw invalid("currentBalance", "Current balance cannot exceed original amount");
}

export interface DebtFields {
  name: string;
  debtType: DebtType;
  lender?: string;
  /** Stored minor units. */
  originalAmount: number;
  currentBalance: number;
  interestRate?: number;
  minimumPayment?: number;
  dueDate?: string;
  linkedAccountId?: string;
}

export async function createDebt(tx: Tx, userId: string, args: DebtFields): Promise<Debt> {
  assertAmounts(args.originalAmount, args.currentBalance);
  if (args.linkedAccountId) await getAccount(tx, userId, args.linkedAccountId);
  const [debt] = await tx
    .insert(debts)
    .values({
      userId,
      name: args.name,
      debtType: args.debtType,
      lender: args.lender ?? null,
      originalAmount: args.originalAmount,
      currentBalance: args.currentBalance,
      interestRate: args.interestRate ?? null,
      minimumPayment: args.minimumPayment ?? null,
      dueDate: args.dueDate ?? null,
      linkedAccountId: args.linkedAccountId ?? null,
    })
    .returning();
  return debt!;
}

/** Changes only the fields given (none can be cleared). Changed amounts are checked against the stored ones. */
export async function updateDebt(
  tx: Tx,
  userId: string,
  id: string,
  fields: Partial<DebtFields>,
): Promise<Debt> {
  const debt = await getDebt(tx, userId, id);
  // Only when an amount changes: removing a payment may leave the balance above the original amount
  // (as Convex did), and that must not block renaming the debt.
  if (fields.originalAmount !== undefined || fields.currentBalance !== undefined) {
    assertAmounts(fields.originalAmount ?? debt.originalAmount, fields.currentBalance ?? debt.currentBalance);
  }
  if (fields.linkedAccountId) await getAccount(tx, userId, fields.linkedAccountId);
  const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return debt;
  const [updated] = await tx.update(debts).set(patch).where(ownedDebt(userId, id)).returning();
  return updated!;
}

/** `true` archives (soft delete), `false` restores. No amount checks: a legacy row can always be archived. */
export async function setDebtArchived(tx: Tx, userId: string, id: string, archived: boolean): Promise<Debt> {
  const [debt] = await tx.update(debts).set({ archived }).where(ownedDebt(userId, id)).returning();
  if (!debt) throw notFound("Debt");
  return debt;
}

/** The transactions the payments created that are still there. */
async function paymentRows(tx: Tx, userId: string, payments: DebtPayment[]): Promise<Transaction[]> {
  const ids = payments.flatMap((p) => [p.sourceTransactionId, p.liabilityTransactionId]).filter((id): id is string => id !== null);
  if (ids.length === 0) return [];
  return await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids)));
}

/** Delete the debt and all its payments, with their transactions and balance effects. */
export async function deleteDebt(tx: Tx, userId: string, id: string): Promise<void> {
  await getDebt(tx, userId, id);
  const payments = await tx
    .select()
    .from(debtPayments)
    .where(and(eq(debtPayments.userId, userId), eq(debtPayments.debtId, id)));
  await deleteTransactionRows(tx, userId, await paymentRows(tx, userId, payments));
  await tx.delete(debtPayments).where(and(eq(debtPayments.userId, userId), eq(debtPayments.debtId, id)));
  await tx.delete(debts).where(ownedDebt(userId, id));
}

/* Payments ----------------------------------------------------------------- */

/** The debt's payments, newest first. */
export async function listDebtPayments(tx: Tx, userId: string, debtId: string): Promise<DebtPayment[]> {
  await getDebt(tx, userId, debtId);
  return await tx
    .select()
    .from(debtPayments)
    .where(and(eq(debtPayments.userId, userId), eq(debtPayments.debtId, debtId)))
    .orderBy(desc(debtPayments.createdAt), desc(debtPayments.id))
    .limit(PAYMENTS_LIMIT);
}

export interface DebtPaymentFields {
  debtId: string;
  /** Stored minor units, positive. */
  amount: number;
  /** Defaults to `amount`. */
  principalAmount?: number;
  /** Defaults to 0. */
  interestAmount?: number;
  date: string;
  note?: string;
  fromAccountId: string;
}

/**
 * Record the payment: the expense on the paying account, the principal
 * adjustment on the linked account, and the principal off the debt's
 * balance. The principal can't exceed what is left.
 */
export async function recordDebtPayment(tx: Tx, userId: string, args: DebtPaymentFields): Promise<DebtPayment> {
  if (!Number.isSafeInteger(args.amount) || args.amount <= 0) throw invalid("amount", "Amount must be positive");
  const debt = await getDebt(tx, userId, args.debtId);
  await getAccount(tx, userId, args.fromAccountId);

  const principalAmount = args.principalAmount ?? args.amount;
  const interestAmount = args.interestAmount ?? 0;
  if (principalAmount < 0 || interestAmount < 0) throw invalid("principalAmount", "Principal and interest cannot be negative");
  if (principalAmount + interestAmount !== args.amount) {
    throw invalid("amount", "Principal and interest must add up to the payment amount");
  }
  if (principalAmount > debt.currentBalance) {
    throw invalid("principalAmount", "Principal amount cannot exceed the remaining balance");
  }

  const source = await createTransaction(tx, userId, {
    type: "expense",
    amount: args.amount,
    accountId: args.fromAccountId,
    date: args.date,
    description: `Debt payment: ${debt.name}`,
    note: args.note,
  });
  const liability =
    debt.linkedAccountId && principalAmount > 0
      ? await createTransaction(tx, userId, {
          type: "adjustment",
          amount: -principalAmount,
          accountId: debt.linkedAccountId,
          date: args.date,
          description: `Debt principal payment: ${debt.name}`,
          note: args.note,
        })
      : null;

  const [payment] = await tx
    .insert(debtPayments)
    .values({
      userId,
      debtId: debt.id,
      amount: args.amount,
      principalAmount,
      interestAmount,
      date: args.date,
      note: args.note ?? null,
      fromAccountId: args.fromAccountId,
      sourceTransactionId: source.id,
      liabilityTransactionId: liability?.id ?? null,
    })
    .returning();
  await tx
    .update(debts)
    .set({ currentBalance: sql`${debts.currentBalance} - ${principalAmount}` })
    .where(ownedDebt(userId, debt.id));
  return payment!;
}

/** Delete the payment and its transactions, reversing their balance effects, and put the principal back on the debt. */
export async function removeDebtPayment(tx: Tx, userId: string, id: string): Promise<void> {
  const [payment] = await tx
    .select()
    .from(debtPayments)
    .where(and(eq(debtPayments.id, id), eq(debtPayments.userId, userId)))
    .limit(1);
  if (!payment) throw notFound("Debt payment");

  await deleteTransactionRows(tx, userId, await paymentRows(tx, userId, [payment]));
  await tx.delete(debtPayments).where(eq(debtPayments.id, payment.id));
  await tx
    .update(debts)
    .set({ currentBalance: sql`${debts.currentBalance} + ${payment.principalAmount}` })
    .where(ownedDebt(userId, payment.debtId));
}
