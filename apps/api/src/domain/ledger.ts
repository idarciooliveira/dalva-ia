/**
 * The ledger: the only code that writes `transactions` rows' money fields and
 * moves `accounts.balance`.
 *
 * An entry is what one write posts: a single income/expense/adjustment row,
 * or a transfer's two linked legs (`linked_transaction_id` both ways, one
 * `transfer_group_id`, `destination_account_id` on the outgoing leg). Every
 * balance move is derived from the rows themselves: posting applies their
 * effect, amending applies the difference, reversing undoes it. Callers never
 * compute a signed delta.
 *
 * Every entry has one owner: the goal contribution or debt payment that
 * records it, else `transfer` for transfer legs, else `manual`. Only the owner
 * may change it (`open` refuses everyone else).
 *
 * Legacy rows (imported from Convex) may have no account (`account_id` null):
 * they move no balance. A transfer leg may have lost its pair; it is then an
 * entry of one leg that can be reversed but not amended.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, or, sql } from "drizzle-orm";

import { accounts, debtPayments, goalContributions, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { conflict, invalid, notFound } from "./errors";
import { fitsMoney } from "./money";

type Transaction = typeof transactions.$inferSelect;
type Account = typeof accounts.$inferSelect;

/** Who may change an entry. Precedence when several apply: goal contribution, transfer, debt payment, manual. */
export type Owner = "manual" | "transfer" | "goal_contribution" | "debt_payment";

export const MANAGED_MESSAGES: Record<Owner, string> = {
  manual: "Transaction must be changed through the transaction endpoints",
  transfer: "Transfer legs must be changed through the transfer endpoints",
  goal_contribution: "Goal contribution transfers must be changed through the goal contribution endpoints",
  debt_payment: "Debt payment transactions must be changed through the debt payment endpoints",
};

export interface SingleEntry {
  kind: "single";
  /** The row's id. */
  id: string;
  owner: Owner;
  row: Transaction;
}

/** Either leg may be missing on legacy data (its pair was deleted in Convex). */
export interface TransferEntry {
  kind: "transfer";
  /** The outgoing leg's id when there is one (what goal contributions point at), else the incoming leg's. */
  id: string;
  owner: Owner;
  outgoing: Transaction | null;
  incoming: Transaction | null;
}

export type Entry = SingleEntry | TransferEntry;

interface Details {
  date: string;
  description?: string;
  note?: string;
}

export interface SinglePosting extends Details {
  type: "income" | "expense" | "adjustment";
  /** Positive, except adjustments: signed, the delta on the balance. */
  amount: number;
  accountId: string;
  categoryId?: string;
  subcategoryId?: string;
  payee?: string;
}

export interface TransferPosting extends Details {
  type: "transfer";
  /** Positive, in the accounts' one currency. */
  amount: number;
  fromAccountId: string;
  toAccountId: string;
}

export type Posting = SinglePosting | TransferPosting;

/** Omitted fields are unchanged; `null` clears a nullable one. */
export interface SingleChanges {
  type?: SinglePosting["type"];
  amount?: number;
  accountId?: string;
  categoryId?: string;
  subcategoryId?: string | null;
  date?: string;
  description?: string | null;
  note?: string | null;
  payee?: string | null;
}

/** Omitted fields are unchanged; `null` clears `description`/`note` on both legs. */
export interface TransferChanges {
  amount?: number;
  fromAccountId?: string;
  toAccountId?: string;
  date?: string;
  description?: string | null;
  note?: string | null;
}

/* Reading ------------------------------------------------------------------ */

const ownedRow = (userId: string, id: string) => and(eq(transactions.id, id), eq(transactions.userId, userId));

/** A row that is, or once was, part of a transfer. Rows that only carry a link (legacy) belong to transfers too, but only `transfer` rows form one. */
const isTransferLeg = (row: Transaction) =>
  row.type === "transfer" || row.transferGroupId !== null || row.linkedTransactionId !== null;

const RANK: Record<Owner, number> = { goal_contribution: 3, transfer: 2, debt_payment: 1, manual: 0 };

/** Each row's owner, in one place and with one precedence. Only the caller's goal and debt rows count. */
export async function ownersOf(tx: Tx, userId: string, rows: Transaction[]): Promise<Map<string, Owner>> {
  const owners = new Map<string, Owner>();
  if (rows.length === 0) return owners;
  const ids = [...new Set(rows.map((r) => r.id))];
  const legIds = [...new Set(rows.flatMap((r) => (r.linkedTransactionId ? [r.id, r.linkedTransactionId] : [r.id])))];
  const contributions = await tx
    .select({ transactionId: goalContributions.transactionId })
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), inArray(goalContributions.transactionId, legIds)));
  const payments = await tx
    .select({ source: debtPayments.sourceTransactionId, liability: debtPayments.liabilityTransactionId })
    .from(debtPayments)
    .where(
      and(eq(debtPayments.userId, userId), or(inArray(debtPayments.sourceTransactionId, ids), inArray(debtPayments.liabilityTransactionId, ids))),
    );
  const contributed = new Set(contributions.map((c) => c.transactionId));
  const paid = new Set(payments.flatMap((p) => [p.source, p.liability]));
  for (const row of rows) {
    const owner: Owner =
      contributed.has(row.id) || (row.linkedTransactionId !== null && contributed.has(row.linkedTransactionId))
        ? "goal_contribution"
        : isTransferLeg(row)
          ? "transfer"
          : paid.has(row.id)
            ? "debt_payment"
            : "manual";
    owners.set(row.id, owner);
  }
  return owners;
}

/**
 * Tells a transfer's legs apart, with the same answer from either leg. The
 * outgoing leg is the one that carries `destination_account_id`. Imported
 * transfers whose destination account was deleted have it nulled: the
 * incoming leg is then the one without an account. When neither tells them
 * apart, the smaller id is outgoing. A leg without its pair is the outgoing
 * one when it carries `destination_account_id`, else the incoming one.
 */
function transferLegs(row: Transaction, linked: Transaction | null): { outgoing: Transaction | null; incoming: Transaction | null } {
  if (linked === null) return row.destinationAccountId !== null ? { outgoing: row, incoming: null } : { outgoing: null, incoming: row };
  const [first, second] = row.id < linked.id ? [row, linked] : [linked, row];
  const marks = (leg: Transaction) => [leg.destinationAccountId !== null, leg.accountId !== null];
  const [a, b] = [marks(first), marks(second)];
  // The first mark that only one leg has decides; none does: the smaller id.
  const decided = a.findIndex((mark, i) => mark !== b[i]);
  const firstIsOutgoing = decided === -1 || a[decided]!;
  return firstIsOutgoing ? { outgoing: first, incoming: second } : { outgoing: second, incoming: first };
}

const legsOf = (entry: Entry): Transaction[] =>
  entry.kind === "single" ? [entry.row] : [entry.outgoing, entry.incoming].filter((leg) => leg !== null);

/** One entry per set of rows: both legs of a transfer open the same entry. */
function distinct(entries: Entry[]): Entry[] {
  const byRows = new Map<string, Entry>();
  for (const entry of entries) {
    const key = legsOf(entry).map((leg) => leg.id).sort().join(",");
    if (!byRows.has(key)) byRows.set(key, entry);
  }
  return [...byRows.values()];
}

async function entriesOf(tx: Tx, userId: string, rows: Transaction[]): Promise<Entry[]> {
  const linkedIds = rows.flatMap((r) => (r.type === "transfer" && r.linkedTransactionId ? [r.linkedTransactionId] : []));
  const linked =
    linkedIds.length === 0
      ? []
      : await tx.select().from(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, linkedIds)));
  const byId = new Map(linked.map((r) => [r.id, r]));
  const owners = await ownersOf(tx, userId, [...rows, ...linked]);
  return rows.map((row): Entry => {
    if (row.type !== "transfer") return { kind: "single", id: row.id, owner: owners.get(row.id)!, row };
    const { outgoing, incoming } = transferLegs(row, row.linkedTransactionId ? (byId.get(row.linkedTransactionId) ?? null) : null);
    const legs = [outgoing, incoming].filter((leg) => leg !== null);
    const owner = legs.map((leg) => owners.get(leg.id)!).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
    return { kind: "transfer", id: (outgoing ?? incoming)!.id, owner, outgoing, incoming };
  });
}

/**
 * The entries holding rows `ids`, for `as` to change. `not_found` when a row
 * is missing (or another user's); `conflict` when someone else owns it.
 * Transfers address transfer legs only: any other row is not a transfer
 * (`not_found`).
 */
export async function openAll(tx: Tx, userId: string, ids: string[], as: Owner, mode: "write" | "read" = "write"): Promise<Entry[]> {
  const what = as === "transfer" ? "Transfer" : "Transaction";
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await tx.select().from(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, unique)));
  if (rows.length !== unique.length) throw notFound(what);
  const entries = distinct(await entriesOf(tx, userId, rows));
  for (const entry of entries) {
    if (as === "transfer" && entry.kind !== "transfer") throw notFound(what);
    if (mode === "write" && entry.owner !== as) throw conflict(MANAGED_MESSAGES[entry.owner]);
  }
  return entries;
}

/** `openAll` for one row. `read` skips the owner check: the entry as `as` addresses it, whoever owns it. */
export function open(tx: Tx, userId: string, id: string, as: "manual"): Promise<SingleEntry>;
export function open(tx: Tx, userId: string, id: string, as: "transfer", mode?: "write" | "read"): Promise<TransferEntry>;
export function open(tx: Tx, userId: string, id: string, as: Owner): Promise<Entry>;
export async function open(tx: Tx, userId: string, id: string, as: Owner, mode: "write" | "read" = "write"): Promise<Entry> {
  return (await openAll(tx, userId, [id], as, mode))[0]!;
}

/* Balances ----------------------------------------------------------------- */

/** Exact: a sum of safe-integer amounts can leave the safe range before the final balance comes back into it. */
type Effect = [accountId: string | null, delta: bigint];

/** What the entry's rows did to their accounts. Rows without an account did nothing. */
function effects(entry: Entry): Effect[] {
  if (entry.kind === "single") {
    const { row } = entry;
    return [[row.accountId, BigInt(row.type === "expense" ? -row.amount : row.amount)]];
  }
  return [
    ...(entry.outgoing ? [[entry.outgoing.accountId, -BigInt(entry.outgoing.amount)] as Effect] : []),
    ...(entry.incoming ? [[entry.incoming.accountId, BigInt(entry.incoming.amount)] as Effect] : []),
  ];
}

const negate = (list: Effect[]): Effect[] => list.map(([accountId, delta]) => [accountId, -delta]);

/** Applies the deltas, one update per account in id order (no deadlocks), each balance checked against its currency's range. */
async function move(tx: Tx, userId: string, list: Effect[]): Promise<void> {
  const sums = new Map<string, bigint>();
  for (const [accountId, delta] of list) {
    if (accountId !== null) sums.set(accountId, (sums.get(accountId) ?? 0n) + delta);
  }
  for (const [accountId, delta] of [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (delta === 0n) continue;
    const [account] = await tx
      .update(accounts)
      // Bound as text: the exact value, never through a number.
      .set({ balance: sql`${accounts.balance} + ${delta.toString()}::bigint` })
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .returning({ balance: accounts.balance, currency: accounts.currency });
    if (!account) throw notFound("Account");
    if (!Number.isSafeInteger(account.balance) || !fitsMoney(account.balance, account.currency)) {
      throw invalid("amount.amountMinor", "Balance out of range");
    }
  }
}

/* Validation --------------------------------------------------------------- */

function assertAmount(type: Transaction["type"], amount: number) {
  if (!Number.isSafeInteger(amount)) throw invalid("amount", "Amount must be an integer");
  if (type !== "adjustment" && amount <= 0) throw invalid("amount.amountMinor", "Amount must be positive");
}

async function account(tx: Tx, userId: string, id: string): Promise<Account> {
  const [row] = await tx.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))).limit(1);
  if (!row) throw notFound("Account");
  return row;
}

/** The one currency a transfer between these accounts moves. */
export function transferCurrency(from: Pick<Account, "id" | "currency">, to: Pick<Account, "id" | "currency">): string {
  if (from.id === to.id) throw invalid("toAccountId", "Cannot transfer to the same account");
  if (from.currency !== to.currency) {
    throw invalid("toAccountId", `Cross-currency transfers are not supported (${from.currency} -> ${to.currency})`);
  }
  return from.currency;
}

async function transferAccounts(tx: Tx, userId: string, fromAccountId: string, toAccountId: string) {
  if (fromAccountId === toAccountId) throw invalid("toAccountId", "Cannot transfer to the same account");
  const from = await account(tx, userId, fromAccountId);
  const to = await account(tx, userId, toAccountId);
  return { from, to, currency: transferCurrency(from, to) };
}

/* Writing ------------------------------------------------------------------ */

/**
 * Writes a new entry and moves its accounts. Its `owner` is the one it has as
 * posted (`manual` or `transfer`): a goal or debt takes it over by recording
 * its own row afterwards. Categories are the caller's to check.
 */
export function post(tx: Tx, userId: string, posting: SinglePosting): Promise<SingleEntry>;
export function post(tx: Tx, userId: string, posting: TransferPosting): Promise<TransferEntry>;
export function post(tx: Tx, userId: string, posting: Posting): Promise<Entry>;
export async function post(tx: Tx, userId: string, posting: Posting): Promise<Entry> {
  assertAmount(posting.type, posting.amount);
  const entry = posting.type === "transfer" ? await insertTransfer(tx, userId, posting) : await insertSingle(tx, userId, posting);
  await move(tx, userId, effects(entry));
  return entry;
}

async function insertSingle(tx: Tx, userId: string, posting: SinglePosting): Promise<SingleEntry> {
  await account(tx, userId, posting.accountId);
  const [row] = await tx
    .insert(transactions)
    .values({
      userId,
      type: posting.type,
      amount: posting.amount,
      accountId: posting.accountId,
      categoryId: posting.categoryId ?? null,
      subcategoryId: posting.subcategoryId ?? null,
      date: posting.date,
      description: posting.description ?? null,
      note: posting.note ?? null,
      payee: posting.payee ?? null,
    })
    .returning();
  return { kind: "single", id: row!.id, owner: "manual", row: row! };
}

async function insertTransfer(tx: Tx, userId: string, posting: TransferPosting): Promise<TransferEntry> {
  await transferAccounts(tx, userId, posting.fromAccountId, posting.toAccountId);
  const shared = {
    userId,
    type: "transfer" as const,
    amount: posting.amount,
    transferGroupId: randomUUID(),
    date: posting.date,
    description: posting.description ?? null,
    note: posting.note ?? null,
  };
  const [outgoing] = await tx
    .insert(transactions)
    .values({ ...shared, accountId: posting.fromAccountId, destinationAccountId: posting.toAccountId })
    .returning();
  const [incoming] = await tx
    .insert(transactions)
    .values({ ...shared, accountId: posting.toAccountId, linkedTransactionId: outgoing!.id })
    .returning();
  const [linkedOutgoing] = await tx
    .update(transactions)
    .set({ linkedTransactionId: incoming!.id })
    .where(ownedRow(userId, outgoing!.id))
    .returning();
  return { kind: "transfer", id: outgoing!.id, owner: "transfer", outgoing: linkedOutgoing!, incoming: incoming! };
}

/** Rewrites an opened entry's rows and moves the accounts by the difference. */
export function amend(tx: Tx, userId: string, entry: SingleEntry, changes: SingleChanges): Promise<SingleEntry>;
export function amend(tx: Tx, userId: string, entry: TransferEntry, changes: TransferChanges): Promise<TransferEntry>;
export async function amend(
  tx: Tx,
  userId: string,
  entry: Entry,
  changes: SingleChanges | TransferChanges,
): Promise<Entry> {
  const amended =
    entry.kind === "single"
      ? await amendSingle(tx, userId, entry, changes as SingleChanges)
      : await amendTransfer(tx, userId, entry, changes as TransferChanges);
  await move(tx, userId, [...negate(effects(entry)), ...effects(amended)]);
  return amended;
}

const patchOf = <T extends object>(changes: T): Partial<T> =>
  Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<T>;

async function amendSingle(tx: Tx, userId: string, entry: SingleEntry, changes: SingleChanges): Promise<SingleEntry> {
  const { row } = entry;
  if (changes.accountId !== undefined && changes.accountId !== row.accountId) await account(tx, userId, changes.accountId);
  assertAmount(changes.type ?? row.type, changes.amount ?? row.amount);
  const patch = patchOf(changes);
  if (Object.keys(patch).length === 0) return entry;
  const [updated] = await tx.update(transactions).set(patch).where(ownedRow(userId, row.id)).returning();
  return { ...entry, row: updated! };
}

async function amendTransfer(tx: Tx, userId: string, entry: TransferEntry, changes: TransferChanges): Promise<TransferEntry> {
  const { outgoing, incoming } = entry;
  if (!outgoing || !incoming) throw notFound("Transfer");
  assertAmount("transfer", changes.amount ?? outgoing.amount);
  const fromAccountId = changes.fromAccountId ?? outgoing.accountId;
  const toAccountId = changes.toAccountId ?? incoming.accountId;
  if (fromAccountId === null || toAccountId === null) throw notFound("Account");
  const { from, to, currency } = await transferAccounts(tx, userId, fromAccountId, toAccountId);
  // Each leg's amount is in its old account's currency (legacy legs may differ): it can't carry over to another one.
  if (changes.amount === undefined) {
    const known = new Map([from, to].map((a) => [a.id, a.currency]));
    for (const leg of [outgoing, incoming]) {
      if (leg.accountId === null) continue;
      const before = known.get(leg.accountId) ?? (await account(tx, userId, leg.accountId)).currency;
      if (before !== currency) throw invalid("amount", "Provide amount when moving a transfer to accounts in another currency");
    }
  }

  const shared = patchOf({ amount: changes.amount, date: changes.date, description: changes.description, note: changes.note });
  const write = async (leg: Transaction, patch: Partial<Transaction>) =>
    Object.keys(patch).length === 0
      ? leg
      : (await tx.update(transactions).set(patch).where(ownedRow(userId, leg.id)).returning())[0]!;
  return {
    ...entry,
    outgoing: await write(outgoing, { ...shared, ...patchOf({ accountId: changes.fromAccountId, destinationAccountId: changes.toAccountId }) }),
    incoming: await write(incoming, { ...shared, ...patchOf({ accountId: changes.toAccountId }) }),
  };
}

/** Deletes the opened entries' rows and undoes what they did to their accounts. */
export async function reverse(tx: Tx, userId: string, opened: Entry[]): Promise<void> {
  const entries = distinct(opened);
  const legs = entries.flatMap(legsOf);
  if (legs.length === 0) return;
  await tx.delete(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, legs.map((leg) => leg.id))));
  await move(tx, userId, entries.flatMap((entry) => negate(effects(entry))));
}
