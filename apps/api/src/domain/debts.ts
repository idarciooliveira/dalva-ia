/**
 * Debts and their payments, in the user's base currency. A payment is an
 * expense on the paying account plus, for a debt linked to a liability
 * account, an adjustment that pays it down: both accounts in the base
 * currency.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { debtPayments, debts } from "../db/schema";
import type { Tx } from "../db/tx";
import { requireBaseCurrencyAccount } from "./accounts";
import { invalid, notFound } from "./errors";
import * as ledger from "./ledger";
import { appAmount, type Money, toMoney } from "./money";
import { requireBaseCurrency } from "./userProfiles";

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

/** A debt with the base currency its amounts are in. */
export interface CurrencyDebt {
  debt: Debt;
  currency: string;
}

export interface DebtFields {
  name: string;
  debtType: DebtType;
  lender?: string;
  /** Money fields are in the base currency. */
  originalAmount: Money;
  /** Remaining principal, at most `originalAmount`. */
  currentBalance: Money;
  interestRate?: number;
  minimumPayment?: Money;
  dueDate?: string;
  /** Liability account whose balance payments pay down, in the base currency. */
  linkedAccountId?: string;
}

const MONEY_FIELDS = ["originalAmount", "currentBalance", "minimumPayment"] as const;

/** Stored amounts for the Money fields given, each checked to be in the base currency. */
function storedAmounts(fields: Partial<DebtFields>, currency: string) {
  const out: Partial<Record<(typeof MONEY_FIELDS)[number], number>> = {};
  for (const field of MONEY_FIELDS) {
    const money = fields[field];
    if (money) out[field] = appAmount(money, currency, field);
  }
  return out;
}

export async function createDebt(tx: Tx, userId: string, args: DebtFields): Promise<CurrencyDebt> {
  const currency = await requireBaseCurrency(tx, userId);
  const amounts = storedAmounts(args, currency);
  assertAmounts(amounts.originalAmount!, amounts.currentBalance!);
  if (args.linkedAccountId) await requireBaseCurrencyAccount(tx, userId, args.linkedAccountId, "linkedAccountId", currency);
  const [debt] = await tx
    .insert(debts)
    .values({
      userId,
      name: args.name,
      debtType: args.debtType,
      lender: args.lender ?? null,
      originalAmount: amounts.originalAmount!,
      currentBalance: amounts.currentBalance!,
      interestRate: args.interestRate ?? null,
      minimumPayment: amounts.minimumPayment ?? null,
      dueDate: args.dueDate ?? null,
      linkedAccountId: args.linkedAccountId ?? null,
    })
    .returning();
  return { debt: debt!, currency };
}

/**
 * Only the given fields change. The amounts are checked against the stored
 * ones (`currentBalance` at most `originalAmount`). Payments don't change
 * when the balance is edited by hand.
 */
export async function updateDebt(tx: Tx, userId: string, id: string, fields: Partial<DebtFields>): Promise<CurrencyDebt> {
  const debt = await getDebt(tx, userId, id);
  const currency = await requireBaseCurrency(tx, userId);
  const amounts = storedAmounts(fields, currency);
  if (amounts.originalAmount !== undefined || amounts.currentBalance !== undefined) {
    assertAmounts(amounts.originalAmount ?? debt.originalAmount, amounts.currentBalance ?? debt.currentBalance);
  }
  // Only a new link must be in the base currency: Convex never checked, so an existing debt may be linked to another one.
  if (fields.linkedAccountId && fields.linkedAccountId !== debt.linkedAccountId) {
    await requireBaseCurrencyAccount(tx, userId, fields.linkedAccountId, "linkedAccountId", currency);
  }
  const patch = Object.fromEntries(Object.entries({ ...fields, ...amounts }).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return { debt, currency };
  const [updated] = await tx.update(debts).set(patch).where(ownedDebt(userId, id)).returning();
  return { debt: updated!, currency };
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

/** Money in the base currency. `principalAmount` defaults to `amount` and `interestAmount` to 0; they must add up to `amount`. */
export interface DebtPaymentFields {
  debtId: string;
  amount: Money;
  principalAmount?: Money;
  interestAmount?: Money;
  date: string;
  note?: string;
  fromAccountId: string;
}

export async function recordDebtPayment(
  tx: Tx,
  userId: string,
  args: DebtPaymentFields,
): Promise<{ payment: DebtPayment; currency: string }> {
  const debt = await getDebt(tx, userId, args.debtId);
  const currency = await requireBaseCurrency(tx, userId);
  const from = await requireBaseCurrencyAccount(tx, userId, args.fromAccountId, "fromAccountId", currency, { owner: "debt" });
  const liabilityAccount = debt.linkedAccountId
    ? await requireBaseCurrencyAccount(tx, userId, debt.linkedAccountId, "debtId", currency, { account: "Linked account", owner: "debt" })
    : null;

  // Conversions are exact (or refused), so the stored amounts add up exactly when the Money does.
  const amount = appAmount(args.amount, currency, "amount");
  if (amount <= 0) throw invalid("amount.amountMinor", "Amount must be positive");
  const principalAmount = args.principalAmount ? appAmount(args.principalAmount, currency, "principalAmount") : amount;
  const interestAmount = args.interestAmount ? appAmount(args.interestAmount, currency, "interestAmount") : 0;
  if (principalAmount < 0 || interestAmount < 0) throw invalid("principalAmount", "Principal and interest cannot be negative");
  if (principalAmount + interestAmount !== amount) {
    throw invalid("amount", "Principal and interest must add up to the payment amount");
  }
  if (principalAmount > debt.currentBalance) {
    throw invalid("principalAmount", "Principal amount cannot exceed the remaining balance");
  }

  const source = await ledger.post(tx, userId, {
    type: "expense",
    amount: args.amount,
    accountId: from,
    date: args.date,
    description: `Debt payment: ${debt.name}`,
    note: args.note,
  });
  // An adjustment's amount is signed: the principal paid lowers the linked liability account's balance by that much.
  const liability =
    liabilityAccount && principalAmount > 0
      ? await ledger.post(tx, userId, {
          type: "adjustment",
          amount: toMoney(-principalAmount, currency),
          accountId: liabilityAccount,
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
      amount,
      principalAmount,
      interestAmount,
      date: args.date,
      note: args.note ?? null,
      fromAccountId: from.id,
      sourceTransactionId: source.id,
      liabilityTransactionId: liability?.id ?? null,
    })
    .returning();
  await tx
    .update(debts)
    .set({ currentBalance: sql`${debts.currentBalance} - ${principalAmount}` })
    .where(ownedDebt(userId, debt.id));
  return { payment: payment!, currency };
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
