import { and, asc, eq, sql } from "drizzle-orm";

import { accounts, debtPayments, debts, savingsGoals, transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { conflict, notFound } from "./errors";
import { post } from "./ledger";

export type Account = typeof accounts.$inferSelect;
export type AccountType = Account["type"];

const LIST_LIMIT = 100;

const owned = (userId: string, id: string) => and(eq(accounts.id, id), eq(accounts.userId, userId));

export const ACCOUNT_IN_USE_MESSAGE = "Account has transactions, goals or debts linked to it. Archive it instead of deleting";

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

/** Records a signed `adjustment` on the account; the ledger moves the balance. */
export async function adjustBalance(
  tx: Tx,
  userId: string,
  args: { id: string; amount: number; date: string; note?: string },
): Promise<Account> {
  await post(tx, userId, { type: "adjustment", amount: args.amount, accountId: args.id, date: args.date, description: "Balance adjustment", note: args.note });
  return await getAccount(tx, userId, args.id);
}
