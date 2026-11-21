/**
 * Accounts, ported from `packages/backend/convex/domain/accounts.ts`. Every
 * function takes the caller's user id and only touches that user's rows;
 * missing and foreign accounts are both "Account not found". Amounts are
 * stored minor units (value × 100).
 */
import { currencyExponent } from "@mpf/finance-contract";
import { and, asc, eq, sql } from "drizzle-orm";

import { accounts, debtPayments, debts, savingsGoals, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { conflict, invalid, notFound } from "./errors";

export type Account = typeof accounts.$inferSelect;
export type AccountType = Account["type"];

/** Convex read at most this many accounts per user. */
const LIST_LIMIT = 100;

/** The user's account `id`. */
const owned = (userId: string, id: string) => and(eq(accounts.id, id), eq(accounts.userId, userId));

export const ACCOUNT_IN_USE_MESSAGE = "Account has transactions, goals or debts linked to it. Archive it instead of deleting";

/** The user's accounts, oldest first. Archived ones only with `includeArchived`. */
export async function listAccounts(tx: Tx, userId: string, args: { includeArchived?: boolean } = {}): Promise<Account[]> {
  return await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), args.includeArchived ? undefined : eq(accounts.archived, false)))
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .limit(LIST_LIMIT);
}

export async function getAccount(tx: Tx, userId: string, id: string): Promise<Account> {
  const [account] = await tx
    .select()
    .from(accounts)
    .where(owned(userId, id))
    .limit(1);
  if (!account) throw notFound("Account");
  return account;
}

export async function createAccount(
  tx: Tx,
  userId: string,
  args: { name: string; type: AccountType; balance: number; currency: string; theme?: string },
): Promise<Account> {
  const [account] = await tx
    .insert(accounts)
    .values({ userId, name: args.name, type: args.type, balance: args.balance, currency: args.currency, theme: args.theme ?? null })
    .returning();
  return account!;
}

/** Changes only the fields given. `archived: true` archives (soft delete), `false` restores. */
export async function updateAccount(
  tx: Tx,
  userId: string,
  id: string,
  fields: { name?: string; type?: AccountType; theme?: string; icon?: string; description?: string; archived?: boolean },
): Promise<Account> {
  const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return await getAccount(tx, userId, id);
  const [account] = await tx
    .update(accounts)
    .set(patch)
    .where(owned(userId, id))
    .returning();
  if (!account) throw notFound("Account");
  return account;
}

/**
 * Delete for good, only while nothing references the account: `conflict`
 * otherwise (archive it instead). Convex looked at transactions, goals and
 * debts; destination legs and debt payments are checked too, since their
 * foreign keys would refuse the delete anyway.
 */
export async function deleteAccount(tx: Tx, userId: string, id: string): Promise<void> {
  await getAccount(tx, userId, id);
  const [referenced] = await tx.execute<{ found: boolean }>(sql`
    select (
      exists (select 1 from ${transactions} where ${transactions.userId} = ${userId} and ${transactions.accountId} = ${id})
      or exists (select 1 from ${transactions} where ${transactions.userId} = ${userId} and ${transactions.destinationAccountId} = ${id})
      or exists (select 1 from ${savingsGoals} where ${savingsGoals.userId} = ${userId} and ${savingsGoals.linkedAccountId} = ${id})
      or exists (select 1 from ${debts} where ${debts.userId} = ${userId} and ${debts.linkedAccountId} = ${id})
      or exists (select 1 from ${debtPayments} where ${debtPayments.userId} = ${userId} and ${debtPayments.fromAccountId} = ${id})
    ) as found
  `);
  if (referenced?.found) throw conflict(ACCOUNT_IN_USE_MESSAGE);
  await tx.delete(accounts).where(owned(userId, id));
}

/**
 * Add a signed delta to the balance and record it as an `adjustment`
 * transaction ("Balance adjustment"). Returns the updated account.
 */
export async function adjustBalance(
  tx: Tx,
  userId: string,
  args: { id: string; amount: number; date: string; note?: string },
): Promise<Account> {
  const [account] = await tx
    .update(accounts)
    .set({ balance: sql`${accounts.balance} + ${args.amount}` })
    .where(owned(userId, args.id))
    .returning();
  if (!account) throw notFound("Account");
  // bigint is read as a JS number: refuse a balance it can't hold exactly (the transaction rolls back).
  if (!Number.isSafeInteger(account.balance)) throw invalid("amount.amountMinor", "Balance out of range");
  await tx.insert(transactions).values({
    userId,
    type: "adjustment",
    amount: args.amount,
    accountId: args.id,
    date: args.date,
    description: "Balance adjustment",
    note: args.note ?? null,
  });
  return account;
}

/**
 * Add signed deltas to account balances, as transaction and transfer writes
 * do. Deltas on one account are summed, zero sums and null accounts (legacy
 * orphans, see the schema header) are skipped, and accounts are updated in id
 * order so two writes touching the same pair lock it in the same order.
 * `UPDATE ... SET balance = balance + delta` under SERIALIZABLE: a concurrent
 * write to the same account fails one of them with 40001 and `withTx` reruns
 * it, so no update is lost.
 */
export async function addToBalances(tx: Tx, userId: string, deltas: Array<[accountId: string | null, delta: number]>): Promise<void> {
  const sums = new Map<string, number>();
  for (const [accountId, delta] of deltas) {
    if (accountId !== null) sums.set(accountId, (sums.get(accountId) ?? 0) + delta);
  }
  for (const [accountId, delta] of [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (delta === 0) continue;
    const [account] = await tx
      .update(accounts)
      .set({ balance: sql`${accounts.balance} + ${delta}` })
      .where(owned(userId, accountId))
      .returning({ balance: accounts.balance, currency: accounts.currency });
    if (!account) throw notFound("Account");
    // bigint is read as a JS number, and the API shows the balance in ISO minor units (×10 for KWD):
    // refuse a balance either can't hold exactly (the transaction rolls back).
    const scale = 10 ** Math.max(0, currencyExponent(account.currency) - 2);
    if (!Number.isSafeInteger(account.balance * scale)) throw invalid("amount.amountMinor", "Balance out of range");
  }
}
