import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { isoDateSchema, type TransactionManagedBy } from "@mpf/finance-contract";

import { isUuid } from "../db/ids";
import { debtPayments, goalContributions, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { addToBalances, getAccount } from "./accounts";
import { getCategory, getSubcategory } from "./categories";
import { conflict, invalid, notFound } from "./errors";

export type Transaction = typeof transactions.$inferSelect;
export type TransactionType = Transaction["type"];
type WritableTransactionType = Exclude<TransactionType, "transfer">;

export const ownedTransaction = (userId: string, id: string) => and(eq(transactions.id, id), eq(transactions.userId, userId));

export const NEWEST_FIRST = [desc(transactions.date), desc(transactions.createdAt), desc(transactions.id)] as const;

export const TRANSFER_MANAGED_MESSAGE = "Transfer legs must be changed through the transfer endpoints";
export const DEBT_PAYMENT_MANAGED_MESSAGE = "Debt payment transactions must be changed through the debt payment endpoints";

export async function getTransaction(tx: Tx, userId: string, id: string, what = "Transaction"): Promise<Transaction> {
  const [row] = await tx.select().from(transactions).where(ownedTransaction(userId, id)).limit(1);
  if (!row) throw notFound(what);
  return row;
}

const isTransferLeg = (row: Transaction) =>
  row.type === "transfer" || row.transferGroupId !== null || row.linkedTransactionId !== null;

export async function managedTransactionKind(tx: Tx, userId: string, row: Transaction): Promise<"transfer" | "debt_payment" | null> {
  if (isTransferLeg(row)) return "transfer";
  const [payment] = await tx
    .select({ id: debtPayments.id })
    .from(debtPayments)
    .where(
      and(
        eq(debtPayments.userId, userId),
        or(eq(debtPayments.sourceTransactionId, row.id), eq(debtPayments.liabilityTransactionId, row.id)),
      ),
    )
    .limit(1);
  return payment ? "debt_payment" : null;
}

export async function ownedByContribution(tx: Tx, userId: string, row: Transaction): Promise<boolean> {
  const legs = row.linkedTransactionId ? [row.id, row.linkedTransactionId] : [row.id];
  const [contribution] = await tx
    .select({ id: goalContributions.id })
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), inArray(goalContributions.transactionId, legs)))
    .limit(1);
  return contribution !== undefined;
}

export async function managedKinds(
  tx: Tx,
  userId: string,
  rows: Transaction[],
): Promise<Map<string, TransactionManagedBy>> {
  const kinds = new Map<string, TransactionManagedBy>();
  if (rows.length === 0) return kinds;
  const legs = rows.filter(isTransferLeg);
  const legIds = [...new Set(legs.flatMap((r) => (r.linkedTransactionId ? [r.id, r.linkedTransactionId] : [r.id])))];
  const others = rows.filter((r) => !isTransferLeg(r)).map((r) => r.id);

  const contributions =
    legIds.length === 0
      ? []
      : await tx
          .select({ transactionId: goalContributions.transactionId })
          .from(goalContributions)
          .where(and(eq(goalContributions.userId, userId), inArray(goalContributions.transactionId, legIds)));
  const payments =
    others.length === 0
      ? []
      : await tx
          .select({ source: debtPayments.sourceTransactionId, liability: debtPayments.liabilityTransactionId })
          .from(debtPayments)
          .where(
            and(
              eq(debtPayments.userId, userId),
              or(inArray(debtPayments.sourceTransactionId, others), inArray(debtPayments.liabilityTransactionId, others)),
            ),
          );
  const contributed = new Set(contributions.map((c) => c.transactionId));
  for (const leg of legs) {
    const owned = contributed.has(leg.id) || (leg.linkedTransactionId !== null && contributed.has(leg.linkedTransactionId));
    kinds.set(leg.id, owned ? "goal_contribution" : "transfer");
  }
  const paid = new Set(payments.flatMap((p) => [p.source, p.liability]));
  for (const id of others) if (paid.has(id)) kinds.set(id, "debt_payment");
  return kinds;
}

export async function getEditableTransaction(tx: Tx, userId: string, id: string): Promise<Transaction> {
  const row = await getTransaction(tx, userId, id);
  const kind = await managedTransactionKind(tx, userId, row);
  if (kind === "transfer") throw conflict(TRANSFER_MANAGED_MESSAGE);
  if (kind === "debt_payment") throw conflict(DEBT_PAYMENT_MANAGED_MESSAGE);
  return row;
}

function balanceDelta(type: TransactionType, amount: number): number {
  return type === "expense" ? -amount : amount;
}

function assertAmount(type: TransactionType, amount: number) {
  if (!Number.isSafeInteger(amount)) throw invalid("amount", "Amount must be an integer");
  if (type !== "adjustment" && amount <= 0) throw invalid("amount.amountMinor", "Amount must be positive");
}

function assertWritableType(type: TransactionType | undefined) {
  if (type === "transfer") throw invalid("type", "Use the transfer create for transfers");
}

async function checkClassification(
  tx: Tx,
  userId: string,
  args: { categoryId?: string; subcategoryId?: string },
  currentCategoryId: string | null,
) {
  if (args.categoryId) await getCategory(tx, userId, args.categoryId);
  if (args.subcategoryId) {
    const subcategory = await getSubcategory(tx, userId, args.subcategoryId);
    if (subcategory.categoryId !== (args.categoryId ?? currentCategoryId)) {
      throw invalid("subcategoryId", "Subcategory does not belong to the category");
    }
  }
}

function assertNoCategoryOnAdjustment(categoryId: string | null | undefined, subcategoryId: string | null | undefined) {
  if (categoryId) throw invalid("categoryId", "Adjustments cannot have a category");
  if (subcategoryId) throw invalid("subcategoryId", "Adjustments cannot have a subcategory");
}

export interface TransactionFields {
  type: WritableTransactionType;
  amount: number;
  accountId: string;
  categoryId?: string;
  subcategoryId?: string;
  date: string;
  description?: string;
  note?: string;
  payee?: string;
}

export async function createTransaction(tx: Tx, userId: string, args: TransactionFields): Promise<Transaction> {
  assertWritableType(args.type);
  assertAmount(args.type, args.amount);
  await getAccount(tx, userId, args.accountId);
  if (args.type === "adjustment") assertNoCategoryOnAdjustment(args.categoryId, args.subcategoryId);
  await checkClassification(tx, userId, args, null);

  const [row] = await tx
    .insert(transactions)
    .values({
      userId,
      type: args.type,
      amount: args.amount,
      accountId: args.accountId,
      categoryId: args.categoryId ?? null,
      subcategoryId: args.subcategoryId ?? null,
      date: args.date,
      description: args.description ?? null,
      note: args.note ?? null,
      payee: args.payee ?? null,
    })
    .returning();
  await addToBalances(tx, userId, [[args.accountId, balanceDelta(args.type, args.amount)]]);
  return row!;
}

export type TransactionChanges = Partial<Omit<TransactionFields, "subcategoryId" | "description" | "note" | "payee">> & {
  subcategoryId?: string | null;
  description?: string | null;
  note?: string | null;
  payee?: string | null;
};

const changed = <T>(change: T | undefined, stored: T): T => (change === undefined ? stored : change);

export async function updateTransaction(
  tx: Tx,
  userId: string,
  id: string,
  changes: TransactionChanges,
): Promise<Transaction> {
  return await updateLoadedTransaction(tx, userId, await getEditableTransaction(tx, userId, id), changes);
}

export async function updateLoadedTransaction(
  tx: Tx,
  userId: string,
  row: Transaction,
  changes: TransactionChanges,
): Promise<Transaction> {
  const id = row.id;
  assertWritableType(changes.type);

  const type = changes.type ?? row.type;
  const amount = changes.amount ?? row.amount;
  if (type === "adjustment") {
    assertNoCategoryOnAdjustment(changes.categoryId ?? row.categoryId, changed(changes.subcategoryId, row.subcategoryId));
  }
  await checkClassification(tx, userId, { categoryId: changes.categoryId, subcategoryId: changes.subcategoryId ?? undefined }, row.categoryId);
  const accountId = changes.accountId ?? row.accountId;
  if (changes.accountId && changes.accountId !== row.accountId) await getAccount(tx, userId, changes.accountId);
  assertAmount(type, amount);

  const categoryChanged = changes.categoryId !== undefined && changes.categoryId !== row.categoryId;
  const subcategoryId = changed(changes.subcategoryId, categoryChanged ? null : row.subcategoryId);
  const [updated] = await tx
    .update(transactions)
    .set({
      type,
      amount,
      accountId,
      categoryId: changes.categoryId ?? row.categoryId,
      subcategoryId,
      date: changes.date ?? row.date,
      description: changed(changes.description, row.description),
      note: changed(changes.note, row.note),
      payee: changed(changes.payee, row.payee),
    })
    .where(ownedTransaction(userId, id))
    .returning();
  await addToBalances(tx, userId, [
    [row.accountId, -balanceDelta(row.type, row.amount)],
    [accountId, balanceDelta(type, amount)],
  ]);
  return updated!;
}

export async function deleteTransaction(tx: Tx, userId: string, id: string): Promise<void> {
  await deleteTransactionRows(tx, userId, [await getEditableTransaction(tx, userId, id)]);
}

export async function deleteTransactionRows(tx: Tx, userId: string, rows: Transaction[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.delete(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, rows.map((r) => r.id))));
  await addToBalances(tx, userId, rows.map((r): [string | null, number] => [r.accountId, -balanceDelta(r.type, r.amount)]));
}

/** `created_at` is a microsecond string: a JS Date holds milliseconds and would skip or repeat rows created within one. */
export interface SearchPosition {
  date: string;
  createdAtMicros: string;
  id: string;
}

const MICROS_RE = /^-?\d{1,18}$/;

export function encodeSearchCursor(position: SearchPosition): string {
  return Buffer.from(JSON.stringify([position.date, position.createdAtMicros, position.id])).toString("base64url");
}

export function decodeSearchCursor(cursor: string): SearchPosition {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === "string" &&
      isoDateSchema.safeParse(value[0]).success &&
      typeof value[1] === "string" &&
      MICROS_RE.test(value[1]) &&
      typeof value[2] === "string" &&
      isUuid(value[2])
    ) {
      return { date: value[0], createdAtMicros: value[1], id: value[2] };
    }
  } catch {
  }
  throw invalid("cursor", "Invalid cursor");
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

export async function searchTransactions(
  tx: Tx,
  userId: string,
  args: {
    dateFrom?: string;
    dateTo?: string;
    accountId?: string;
    categoryId?: string;
    type?: TransactionType;
    q?: string;
    cursor?: string;
    limit: number;
  },
): Promise<{ items: Transaction[]; nextCursor: string | null }> {
  const after = args.cursor ? decodeSearchCursor(args.cursor) : null;
  const conditions: Array<SQL | undefined> = [
    eq(transactions.userId, userId),
    args.accountId ? eq(transactions.accountId, args.accountId) : undefined,
    args.categoryId ? eq(transactions.categoryId, args.categoryId) : undefined,
    args.type ? eq(transactions.type, args.type) : undefined,
    args.dateFrom ? sql`${transactions.date} >= ${args.dateFrom}` : undefined,
    args.dateTo ? sql`${transactions.date} <= ${args.dateTo}` : undefined,
    args.q
      ? or(
          ilike(transactions.description, likePattern(args.q)),
          ilike(transactions.note, likePattern(args.q)),
          ilike(transactions.payee, likePattern(args.q)),
        )
      : undefined,
    after
      ? sql`(${transactions.date}, ${transactions.createdAt}, ${transactions.id}) < (${after.date}::date, timestamptz 'epoch' + ${after.createdAtMicros}::bigint * interval '1 microsecond', ${after.id}::uuid)`
      : undefined,
  ];
  const rows = await tx
    .select({
      row: transactions,
      createdAtMicros: sql<string>`(extract(epoch from ${transactions.createdAt}) * 1000000)::bigint::text`,
    })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(...NEWEST_FIRST)
    .limit(args.limit + 1);

  const page = rows.slice(0, args.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > args.limit && last
      ? encodeSearchCursor({ date: last.row.date, createdAtMicros: last.createdAtMicros, id: last.row.id })
      : null;
  return { items: page.map((r) => r.row), nextCursor };
}
