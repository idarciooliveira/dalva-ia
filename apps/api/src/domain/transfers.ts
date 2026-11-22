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

import { and, eq, inArray } from "drizzle-orm";

import { transactions } from "../db/schema";
import type { Tx } from "../db/tx";
import { type Account, addToBalances, getAccount } from "./accounts";
import { conflict, invalid, notFound } from "./errors";
import { getTransaction, ownedByContribution, ownedTransaction, type Transaction } from "./transactions";

export const CONTRIBUTION_MANAGED_MESSAGE =
  "Goal contribution transfers must be changed through the goal contribution endpoints";

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
 * Both legs from either one. The outgoing leg carries
 * `destination_account_id`, the incoming leg sits on that same account. When
 * Convex deleted it, the import nulled both, so the incoming leg is then the
 * one without an account (with both accounts gone, which leg is which changes
 * no balance). A leg without its pair is the outgoing one when it carries
 * `destination_account_id`, else the incoming one.
 */
async function legsOf(tx: Tx, userId: string, row: Transaction): Promise<{ outgoing: Transaction | null; incoming: Transaction | null }> {
  const linked = row.linkedTransactionId
    ? ((await tx.select().from(transactions).where(ownedTransaction(userId, row.linkedTransactionId)).limit(1))[0] ?? null)
    : null;
  const rowIsOutgoing =
    row.destinationAccountId !== null ||
    (linked !== null && linked.destinationAccountId === null && row.accountId !== null && linked.accountId === null);
  return rowIsOutgoing ? { outgoing: row, incoming: linked } : { outgoing: linked, incoming: row };
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

/** Two distinct accounts in one currency (there is no conversion). Returns that currency. */
export function transferCurrency(from: Account, to: Account): string {
  if (from.id === to.id) throw invalid("toAccountId", "Cannot transfer to the same account");
  if (from.currency !== to.currency) {
    throw invalid("toAccountId", `Cross-currency transfers are not supported (${from.currency} -> ${to.currency})`);
  }
  return from.currency;
}

/** Distinct accounts of the user's, in one currency. */
async function transferAccounts(tx: Tx, userId: string, fromAccountId: string, toAccountId: string) {
  if (fromAccountId === toAccountId) throw invalid("toAccountId", "Cannot transfer to the same account");
  transferCurrency(await getAccount(tx, userId, fromAccountId), await getAccount(tx, userId, toAccountId));
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
  await tx.update(transactions).set({ linkedTransactionId: incoming!.id }).where(ownedTransaction(userId, outgoing!.id));
  await addToBalances(tx, userId, [
    [args.fromAccountId, -args.amount],
    [args.toAccountId, args.amount],
  ]);
  return outgoing!.id;
}

/** What a transfer update may change: `null` clears the description or note on both legs. */
export type TransferChanges = Partial<Omit<TransferFields, "description" | "note">> & {
  description?: string | null;
  note?: string | null;
};

/**
 * Change the fields given on both legs, reversing the old balance effects and
 * applying the new ones. Returns the outgoing leg's id.
 */
export async function updateTransfer(tx: Tx, userId: string, id: string, changes: TransferChanges): Promise<string> {
  return await updateLoadedTransfer(tx, userId, await getTransfer(tx, userId, id, { editable: true }), changes);
}

/** `updateTransfer` for a transfer the caller loaded with `getTransfer(..., { editable: true })` in this transaction. */
export async function updateLoadedTransfer(
  tx: Tx,
  userId: string,
  { outgoing, incoming }: Transfer,
  changes: TransferChanges,
): Promise<string> {
  const amount = changes.amount ?? outgoing.amount;
  assertAmount(amount);
  const fromAccountId = changes.fromAccountId ?? outgoing.accountId;
  const toAccountId = changes.toAccountId ?? incoming.accountId;
  if (fromAccountId === null || toAccountId === null) throw notFound("Account");
  await transferAccounts(tx, userId, fromAccountId, toAccountId);

  // Only what changed, as Convex patched: legacy legs may disagree on the rest.
  const shared = {
    ...(changes.amount !== undefined && { amount: changes.amount }),
    ...(changes.date !== undefined && { date: changes.date }),
    ...(changes.description !== undefined && { description: changes.description }),
    ...(changes.note !== undefined && { note: changes.note }),
  };
  const patches: Array<[string, Partial<Transaction>]> = [
    [
      outgoing.id,
      {
        ...shared,
        ...(changes.fromAccountId !== undefined && { accountId: changes.fromAccountId }),
        ...(changes.toAccountId !== undefined && { destinationAccountId: changes.toAccountId }),
      },
    ],
    [incoming.id, { ...shared, ...(changes.toAccountId !== undefined && { accountId: changes.toAccountId }) }],
  ];
  for (const [legId, patch] of patches) {
    // A leg nothing changes on (only the source moved: the incoming leg) is left alone.
    if (Object.keys(patch).length > 0) await tx.update(transactions).set(patch).where(ownedTransaction(userId, legId));
  }
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
  await deleteTransferLegs(tx, userId, await getEditableLeg(tx, userId, id));
}

/**
 * `deleteTransfer` from a leg the caller loaded, without the goal-contribution
 * check: for the contribution flow removing its own transfer.
 */
export async function deleteTransferLegs(tx: Tx, userId: string, leg: Transaction): Promise<void> {
  const { outgoing, incoming } = await legsOf(tx, userId, leg);
  const legs = [outgoing, incoming].filter((leg): leg is Transaction => leg !== null);
  await tx.delete(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, legs.map((leg) => leg.id))));
  await addToBalances(tx, userId, [
    [outgoing?.accountId ?? null, outgoing?.amount ?? 0],
    [incoming?.accountId ?? null, -(incoming?.amount ?? 0)],
  ]);
}
