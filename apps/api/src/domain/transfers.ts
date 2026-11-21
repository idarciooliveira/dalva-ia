/**
 * Transfers, ported from `packages/backend/convex/domain/transfers.ts` plus the
 * checks Convex kept in its API layer (`api/v1/transfers.ts`).
 *
 * A transfer is two `transfer` rows sharing `transfer_group_id`: the outgoing
 * leg on the source account (it carries `destination_account_id`) and the
 * incoming leg on the destination account, each pointing at the other through
 * `linked_transaction_id`. Both legs and both balances change in the caller's
 * transaction. Either leg's id addresses the transfer.
 *
 * Transfers made by goal contributions belong to the contribution endpoints:
 * update and delete refuse them with `conflict`.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { type Account, addToBalances, getAccount } from "./accounts";
import { conflict, invalid, notFound } from "./errors";
import { getTransaction, ownedByContribution, type Transaction } from "./transactions";

export const CONTRIBUTION_MANAGED_MESSAGE =
  "Goal contribution transfers must be changed through the goal contribution endpoints";

const owned = (userId: string, id: string) => and(eq(transactions.id, id), eq(transactions.userId, userId));

export interface TransferLegs {
  outgoing: Transaction;
  /** Null for a legacy leg whose pair is gone. */
  incoming: Transaction | null;
}

export interface Transfer {
  outgoing: Transaction;
  incoming: Transaction;
  /** Null for a legacy leg whose account Convex deleted. */
  fromAccount: Account | null;
  toAccount: Account | null;
}

/** A transfer leg of the user's, as "Transfer not found" when it is anything else. */
async function getLeg(tx: Tx, userId: string, id: string): Promise<Transaction> {
  const row = await getTransaction(tx, userId, id, "Transfer");
  if (row.type !== "transfer") throw notFound("Transfer");
  return row;
}

/**
 * Both legs from either one. A leg without its pair is the outgoing one when it
 * carries `destination_account_id`, else the incoming one.
 */
async function legsOf(tx: Tx, userId: string, row: Transaction): Promise<{ outgoing: Transaction | null; incoming: Transaction | null }> {
  const linked = row.linkedTransactionId
    ? ((await tx.select().from(transactions).where(owned(userId, row.linkedTransactionId)).limit(1))[0] ?? null)
    : null;
  if (row.destinationAccountId !== null) return { outgoing: row, incoming: linked };
  return { outgoing: linked, incoming: row };
}

async function accountOrNull(tx: Tx, userId: string, id: string | null): Promise<Account | null> {
  return id === null ? null : await getAccount(tx, userId, id);
}

/**
 * Both legs and their accounts. A leg whose pair is gone is "Transfer not
 * found". `editable`: also refuse a goal contribution's transfer (`conflict`).
 */
export async function getTransfer(tx: Tx, userId: string, id: string, options: { editable?: boolean } = {}): Promise<Transfer> {
  const leg = options.editable ? await getEditableLeg(tx, userId, id) : await getLeg(tx, userId, id);
  const { outgoing, incoming } = await legsOf(tx, userId, leg);
  if (!outgoing || !incoming) throw notFound("Transfer");
  return {
    outgoing,
    incoming,
    fromAccount: await accountOrNull(tx, userId, outgoing.accountId),
    toAccount: await accountOrNull(tx, userId, incoming.accountId),
  };
}

/** A transfer the transfer endpoints may change: not one a goal contribution owns. */
async function getEditableLeg(tx: Tx, userId: string, id: string): Promise<Transaction> {
  const row = await getLeg(tx, userId, id);
  if (await ownedByContribution(tx, userId, row)) throw conflict(CONTRIBUTION_MANAGED_MESSAGE);
  return row;
}

function assertAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid("amount", "Amount must be positive");
}

/** Distinct accounts of the user's, in one currency (there is no conversion). */
async function transferAccounts(tx: Tx, userId: string, fromAccountId: string, toAccountId: string) {
  if (fromAccountId === toAccountId) throw invalid("toAccountId", "Cannot transfer to the same account");
  const from = await getAccount(tx, userId, fromAccountId);
  const to = await getAccount(tx, userId, toAccountId);
  if (from.currency !== to.currency) {
    throw invalid("toAccountId", `Cross-currency transfers are not supported (${from.currency} -> ${to.currency})`);
  }
  return { from, to };
}

export interface TransferFields {
  /** Stored minor units, positive. */
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  description?: string;
  note?: string;
}

/** Insert both legs, debit the source, credit the destination. Returns the outgoing leg's id. */
export async function createTransfer(tx: Tx, userId: string, args: TransferFields): Promise<string> {
  assertAmount(args.amount);
  await transferAccounts(tx, userId, args.fromAccountId, args.toAccountId);

  const shared = {
    userId,
    type: "transfer" as const,
    amount: args.amount,
    transferGroupId: randomUUID(),
    date: args.date,
    description: args.description ?? null,
    note: args.note ?? null,
  };
  // The legs reference each other; the foreign keys are deferred, so the order doesn't matter.
  const [outgoing] = await tx
    .insert(transactions)
    .values({ ...shared, accountId: args.fromAccountId, destinationAccountId: args.toAccountId })
    .returning({ id: transactions.id });
  const [incoming] = await tx
    .insert(transactions)
    .values({ ...shared, accountId: args.toAccountId, linkedTransactionId: outgoing!.id })
    .returning({ id: transactions.id });
  await tx.update(transactions).set({ linkedTransactionId: incoming!.id }).where(owned(userId, outgoing!.id));
  await addToBalances(tx, userId, [
    [args.fromAccountId, -args.amount],
    [args.toAccountId, args.amount],
  ]);
  return outgoing!.id;
}

/**
 * Change the fields given on both legs (none can be cleared), reversing the
 * old balance effects and applying the new ones. Returns the outgoing leg's id.
 */
export async function updateTransfer(tx: Tx, userId: string, id: string, changes: Partial<TransferFields>): Promise<string> {
  const { outgoing, incoming } = await legsOf(tx, userId, await getEditableLeg(tx, userId, id));
  if (!outgoing || !incoming) throw notFound("Transfer");

  const amount = changes.amount ?? outgoing.amount;
  assertAmount(amount);
  const fromAccountId = changes.fromAccountId ?? outgoing.accountId;
  const toAccountId = changes.toAccountId ?? incoming.accountId;
  if (fromAccountId === null || toAccountId === null) throw notFound("Account");
  await transferAccounts(tx, userId, fromAccountId, toAccountId);

  const shared = {
    amount,
    date: changes.date ?? outgoing.date,
    description: changes.description ?? outgoing.description,
    note: changes.note ?? outgoing.note,
  };
  await tx
    .update(transactions)
    .set({ ...shared, accountId: fromAccountId, destinationAccountId: toAccountId })
    .where(owned(userId, outgoing.id));
  await tx
    .update(transactions)
    .set({ ...shared, accountId: toAccountId })
    .where(owned(userId, incoming.id));
  await addToBalances(tx, userId, [
    [outgoing.accountId, outgoing.amount],
    [incoming.accountId, -outgoing.amount],
    [fromAccountId, -amount],
    [toAccountId, amount],
  ]);
  return outgoing.id;
}

/**
 * Delete both legs and reverse both balance effects. A legacy leg whose pair
 * is gone is deleted alone, reversing its own effect.
 */
export async function deleteTransfer(tx: Tx, userId: string, id: string): Promise<void> {
  const { outgoing, incoming } = await legsOf(tx, userId, await getEditableLeg(tx, userId, id));
  const deltas: Array<[string | null, number]> = [];
  if (outgoing) {
    await tx.delete(transactions).where(owned(userId, outgoing.id));
    deltas.push([outgoing.accountId, outgoing.amount]);
  }
  if (incoming) {
    await tx.delete(transactions).where(owned(userId, incoming.id));
    deltas.push([incoming.accountId, -incoming.amount]);
  }
  await addToBalances(tx, userId, deltas);
}
