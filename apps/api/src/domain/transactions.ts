/**
 * Income, expense and adjustment transactions, ported from
 * `packages/backend/convex/domain/transactions.ts` plus the checks Convex kept
 * in its API layer (`api/v1/transactions.ts`). Every function takes the
 * caller's user id and only touches that user's rows; missing and foreign
 * rows are both "not found". Amounts are stored minor units (value × 100).
 *
 * Each write keeps the account balance in step: create applies the row's
 * delta, update reverses the old one and applies the new one, delete reverses
 * it. Rows owned by another flow (transfer legs, goal-contribution transfers,
 * debt-payment rows) are refused with `conflict`: changing them here would
 * leave the paired leg or the owning record out of sync.
 *
 * `account_id` is null on legacy rows whose account Convex deleted (see the
 * schema header): their balance effect is skipped, as Convex skipped a
 * missing account.
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { isoDateSchema } from "@mpf/finance-contract";

import { isUuid } from "../db/ids";
import { debtPayments, goalContributions, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { addToBalances, getAccount } from "./accounts";
import { getCategory, getSubcategory } from "./categories";
import { conflict, invalid, notFound } from "./errors";

export type Transaction = typeof transactions.$inferSelect;
export type TransactionType = Transaction["type"];
/** Types the transaction endpoints write. Transfers have their own. */
type WritableTransactionType = Exclude<TransactionType, "transfer">;

/** The user's transaction `id`. */
export const ownedTransaction = (userId: string, id: string) => and(eq(transactions.id, id), eq(transactions.userId, userId));

/** Newest first: date, then creation order (the id breaks ties within one transaction). */
export const NEWEST_FIRST = [desc(transactions.date), desc(transactions.createdAt), desc(transactions.id)] as const;

export const TRANSFER_MANAGED_MESSAGE = "Transfer legs must be changed through the transfer endpoints";
export const DEBT_PAYMENT_MANAGED_MESSAGE = "Debt payment transactions must be changed through the debt payment endpoints";

/* Lookups ------------------------------------------------------------------ */

export async function getTransaction(tx: Tx, userId: string, id: string, what = "Transaction"): Promise<Transaction> {
  const [row] = await tx.select().from(transactions).where(ownedTransaction(userId, id)).limit(1);
  if (!row) throw notFound(what);
  return row;
}

/** A leg of a transfer (goal-contribution transfers included). */
const isTransferLeg = (row: Transaction) =>
  row.type === "transfer" || row.transferGroupId !== null || row.linkedTransactionId !== null;

/** Transfer legs, and the source or liability rows of a debt payment. */
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

/** Whether a goal contribution owns this transfer (through either leg). */
export async function ownedByContribution(tx: Tx, userId: string, row: Transaction): Promise<boolean> {
  const legs = row.linkedTransactionId ? [row.id, row.linkedTransactionId] : [row.id];
  const [contribution] = await tx
    .select({ id: goalContributions.id })
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), inArray(goalContributions.transactionId, legs)))
    .limit(1);
  return contribution !== undefined;
}

/** The user's transaction, unless another flow owns it (`conflict`). */
export async function getEditableTransaction(tx: Tx, userId: string, id: string): Promise<Transaction> {
  const row = await getTransaction(tx, userId, id);
  const kind = await managedTransactionKind(tx, userId, row);
  if (kind === "transfer") throw conflict(TRANSFER_MANAGED_MESSAGE);
  if (kind === "debt_payment") throw conflict(DEBT_PAYMENT_MANAGED_MESSAGE);
  return row;
}

/* Rules -------------------------------------------------------------------- */

/** Signed effect of a row on its account's balance. Transfers are handled by the transfer flow. */
function balanceDelta(type: TransactionType, amount: number): number {
  return type === "expense" ? -amount : amount;
}

/** Income and expense amounts are positive integers; only adjustments are signed. */
function assertAmount(type: TransactionType, amount: number) {
  if (!Number.isSafeInteger(amount)) throw invalid("amount", "Amount must be an integer");
  if (type !== "adjustment" && amount <= 0) throw invalid("amount.amountMinor", "Amount must be positive");
}

function assertWritableType(type: TransactionType | undefined) {
  if (type === "transfer") throw invalid("type", "Use the transfer create for transfers");
}

/**
 * The category and subcategory must be the user's, and the subcategory must
 * sit under the row's category (the one given, else the current one).
 */
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

/* Writes ------------------------------------------------------------------- */

export interface TransactionFields {
  type: WritableTransactionType;
  /** Stored minor units. */
  amount: number;
  accountId: string;
  categoryId?: string;
  subcategoryId?: string;
  date: string;
  description?: string;
  note?: string;
  payee?: string;
}

/** Insert the row and apply its delta to the account. */
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

/**
 * Change the fields given (none can be cleared). Reverses the old balance
 * effect on the old account and applies the new one on the new account.
 * A new category without a subcategory drops the old subcategory, which
 * belongs to the old category.
 */
export async function updateTransaction(
  tx: Tx,
  userId: string,
  id: string,
  changes: Partial<TransactionFields>,
): Promise<Transaction> {
  return await updateLoadedTransaction(tx, userId, await getEditableTransaction(tx, userId, id), changes);
}

/** `updateTransaction` for a row the caller loaded with `getEditableTransaction` in this transaction. */
export async function updateLoadedTransaction(
  tx: Tx,
  userId: string,
  row: Transaction,
  changes: Partial<TransactionFields>,
): Promise<Transaction> {
  const id = row.id;
  assertWritableType(changes.type);

  const type = changes.type ?? row.type;
  const amount = changes.amount ?? row.amount;
  if (type === "adjustment") {
    assertNoCategoryOnAdjustment(changes.categoryId ?? row.categoryId, changes.subcategoryId ?? row.subcategoryId);
  }
  await checkClassification(tx, userId, changes, row.categoryId);
  const accountId = changes.accountId ?? row.accountId;
  if (changes.accountId && changes.accountId !== row.accountId) await getAccount(tx, userId, changes.accountId);
  assertAmount(type, amount);

  const categoryChanged = changes.categoryId !== undefined && changes.categoryId !== row.categoryId;
  const subcategoryId = changes.subcategoryId ?? (categoryChanged ? null : row.subcategoryId);
  const [updated] = await tx
    .update(transactions)
    .set({
      type,
      amount,
      accountId,
      categoryId: changes.categoryId ?? row.categoryId,
      subcategoryId,
      date: changes.date ?? row.date,
      description: changes.description ?? row.description,
      note: changes.note ?? row.note,
      payee: changes.payee ?? row.payee,
    })
    .where(ownedTransaction(userId, id))
    .returning();
  await addToBalances(tx, userId, [
    [row.accountId, -balanceDelta(row.type, row.amount)],
    [accountId, balanceDelta(type, amount)],
  ]);
  return updated!;
}

/** Delete the row and reverse its balance effect. */
export async function deleteTransaction(tx: Tx, userId: string, id: string): Promise<void> {
  const row = await getEditableTransaction(tx, userId, id);
  await tx.delete(transactions).where(ownedTransaction(userId, id));
  await addToBalances(tx, userId, [[row.accountId, -balanceDelta(row.type, row.amount)]]);
}

/* Search ------------------------------------------------------------------- */

/**
 * Keyset position: the last row returned, by `(date, created_at, id)`, the
 * listing order. `created_at` is kept in microseconds since the epoch, as a
 * decimal string: Postgres stores microseconds and a JS Date only holds
 * milliseconds, which would skip or repeat rows created within one.
 */
export interface SearchPosition {
  date: string;
  createdAtMicros: string;
  id: string;
}

const MICROS_RE = /^-?\d{1,18}$/;

export function encodeSearchCursor(position: SearchPosition): string {
  return Buffer.from(JSON.stringify([position.date, position.createdAtMicros, position.id])).toString("base64url");
}

/** `validation_failed` for anything this module didn't encode. */
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
    // fall through
  }
  throw invalid("cursor", "Invalid cursor");
}

/** `%`, `_` and `\` match themselves in the `q` substring search. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * The user's transactions, newest first, with an opaque keyset cursor.
 * Every filter runs in the query, so a page is short only when it is the
 * last one, and `nextCursor` is null exactly then. `q` is a case-insensitive
 * substring of description, note or payee.
 */
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
