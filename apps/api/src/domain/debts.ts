import { and, asc, desc, eq, sql } from "drizzle-orm";

import { debtPayments, debts } from "../db/schema";
import type { Tx } from "../db/tx";
import { getAccount } from "./accounts";
import { invalid, notFound } from "./errors";
import * as ledger from "./ledger";

export type Debt = typeof debts.$inferSelect;
export type DebtType = Debt["debtType"];
export type DebtPayment = typeof debtPayments.$inferSelect;

const DEBTS_LIMIT = 100;
const PAYMENTS_LIMIT = 500;

const ownedDebt = (userId: string, id: string) => and(eq(debts.id, id), eq(debts.userId, userId));

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

export async function updateDebt(
  tx: Tx,
  userId: string,
  id: string,
  fields: Partial<DebtFields>,
): Promise<Debt> {
  const debt = await getDebt(tx, userId, id);
  if (fields.originalAmount !== undefined || fields.currentBalance !== undefined) {
    assertAmounts(fields.originalAmount ?? debt.originalAmount, fields.currentBalance ?? debt.currentBalance);
  }
  if (fields.linkedAccountId) await getAccount(tx, userId, fields.linkedAccountId);
  const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return debt;
  const [updated] = await tx.update(debts).set(patch).where(ownedDebt(userId, id)).returning();
  return updated!;
}

export async function setDebtArchived(tx: Tx, userId: string, id: string, archived: boolean): Promise<Debt> {
  const [debt] = await tx.update(debts).set({ archived }).where(ownedDebt(userId, id)).returning();
  if (!debt) throw notFound("Debt");
  return debt;
}

/**
 * Reverses what the payments posted. A legacy payment may have lost its source
 * row, or point at a row a goal contribution or transfer also claims: the debt
 * still removes it ("read" skips the owner check), or the debt could never be
 * deleted.
 */
async function reversePayments(tx: Tx, userId: string, payments: DebtPayment[]): Promise<void> {
  const ids = payments.flatMap((p) => [p.sourceTransactionId, p.liabilityTransactionId]).filter((id): id is string => id !== null);
  await ledger.reverse(tx, userId, await ledger.openAll(tx, userId, ids, "debt_payment", "read"));
}

export async function deleteDebt(tx: Tx, userId: string, id: string): Promise<void> {
  await getDebt(tx, userId, id);
  const payments = await tx
    .select()
    .from(debtPayments)
    .where(and(eq(debtPayments.userId, userId), eq(debtPayments.debtId, id)));
  await reversePayments(tx, userId, payments);
  await tx.delete(debtPayments).where(and(eq(debtPayments.userId, userId), eq(debtPayments.debtId, id)));
  await tx.delete(debts).where(ownedDebt(userId, id));
}

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
  amount: number;
  principalAmount?: number;
  interestAmount?: number;
  date: string;
  note?: string;
  fromAccountId: string;
}

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

  const source = await ledger.post(tx, userId, {
    type: "expense",
    amount: args.amount,
    accountId: args.fromAccountId,
    date: args.date,
    description: `Debt payment: ${debt.name}`,
    note: args.note,
  });
  // An adjustment's amount is signed: the principal paid lowers the linked liability account's balance by that much.
  const liabilityAdjustment = -principalAmount;
  const liability =
    debt.linkedAccountId && principalAmount > 0
      ? await ledger.post(tx, userId, {
          type: "adjustment",
          amount: liabilityAdjustment,
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

export async function removeDebtPayment(tx: Tx, userId: string, id: string): Promise<void> {
  const [payment] = await tx
    .select()
    .from(debtPayments)
    .where(and(eq(debtPayments.id, id), eq(debtPayments.userId, userId)))
    .limit(1);
  if (!payment) throw notFound("Debt payment");

  await reversePayments(tx, userId, [payment]);
  await tx.delete(debtPayments).where(eq(debtPayments.id, payment.id));
  await tx
    .update(debts)
    .set({ currentBalance: sql`${debts.currentBalance} + ${payment.principalAmount}` })
    .where(ownedDebt(userId, payment.debtId));
}
