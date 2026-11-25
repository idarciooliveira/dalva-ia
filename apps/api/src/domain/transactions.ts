import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { isoDateSchema } from "@mpf/shared";

import { isUuid } from "../db/ids";
import { transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { getAccount } from "./accounts";
import { getCategory, getSubcategory } from "./categories";
import { invalid, notFound } from "./errors";
import * as ledger from "./ledger";

/** What owns a row that `transactions.update` / `delete` refuse: change it there. */
export type TransactionManagedBy = Exclude<ledger.Owner, "manual">;

export type Transaction = typeof transactions.$inferSelect;
export type TransactionType = Transaction["type"];
type WritableTransactionType = Exclude<TransactionType, "transfer">;

export const NEWEST_FIRST = [desc(transactions.date), desc(transactions.createdAt), desc(transactions.id)] as const;

export async function getTransaction(tx: Tx, userId: string, id: string): Promise<Transaction> {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .limit(1);
  if (!row) throw notFound("Transaction");
  return row;
}

/** Who manages each row that the transaction procedures may not change; plain rows are absent. */
export async function managedBy(tx: Tx, userId: string, rows: Transaction[]): Promise<Map<string, TransactionManagedBy>> {
  const managed = new Map<string, TransactionManagedBy>();
  for (const [id, owner] of await ledger.ownersOf(tx, userId, rows)) if (owner !== "manual") managed.set(id, owner);
  return managed;
}

/** The row as an entry the transaction procedures may change: `conflict` when a transfer, goal or debt manages it. */
export async function getEditableTransaction(tx: Tx, userId: string, id: string): Promise<ledger.SingleEntry> {
  return await ledger.open(tx, userId, id, "manual");
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
  await getAccount(tx, userId, args.accountId);
  if (args.type === "adjustment") assertNoCategoryOnAdjustment(args.categoryId, args.subcategoryId);
  await checkClassification(tx, userId, args, null);
  return (await ledger.post(tx, userId, args)).row;
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

/** Checks the classification, then amends the entry (amount, account and balances are the ledger's). */
export async function updateLoadedTransaction(
  tx: Tx,
  userId: string,
  entry: ledger.SingleEntry,
  changes: TransactionChanges,
): Promise<Transaction> {
  const { row } = entry;
  assertWritableType(changes.type);
  if ((changes.type ?? row.type) === "adjustment") {
    assertNoCategoryOnAdjustment(changes.categoryId ?? row.categoryId, changed(changes.subcategoryId, row.subcategoryId));
  }
  await checkClassification(tx, userId, { categoryId: changes.categoryId, subcategoryId: changes.subcategoryId ?? undefined }, row.categoryId);
  // A new category without a subcategory drops the old subcategory.
  const categoryChanged = changes.categoryId !== undefined && changes.categoryId !== row.categoryId;
  const subcategoryId = changes.subcategoryId === undefined && categoryChanged ? null : changes.subcategoryId;
  return (await ledger.amend(tx, userId, entry, { ...changes, subcategoryId })).row;
}

export async function deleteTransaction(tx: Tx, userId: string, id: string): Promise<void> {
  await ledger.reverse(tx, userId, [await getEditableTransaction(tx, userId, id)]);
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
