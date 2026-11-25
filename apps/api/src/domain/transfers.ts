import type { Tx } from "../db/tx";
import { type Account, getAccount } from "./accounts";
import { notFound } from "./errors";
import * as ledger from "./ledger";
import type { Transaction } from "./transactions";

export { transferCurrency } from "./ledger";

/** Both legs, as the ledger opened them, with their accounts (null when a legacy leg lost its account). */
export interface Transfer {
  entry: ledger.TransferEntry;
  outgoing: Transaction;
  incoming: Transaction;
  fromAccount: Account | null;
  toAccount: Account | null;
}

async function accountOrNull(tx: Tx, userId: string, id: string | null): Promise<Account | null> {
  return id === null ? null : await getAccount(tx, userId, id);
}

/**
 * The transfer either leg belongs to. `editable` refuses one a goal
 * contribution owns (`conflict`); a leg whose pair is gone is `not_found`.
 */
export async function getTransfer(tx: Tx, userId: string, id: string, options: { editable?: boolean } = {}): Promise<Transfer> {
  const entry = await ledger.open(tx, userId, id, "transfer", options.editable ? "write" : "read");
  const { outgoing, incoming } = entry;
  if (!outgoing || !incoming) throw notFound("Transfer");
  return {
    entry,
    outgoing,
    incoming,
    fromAccount: await accountOrNull(tx, userId, outgoing.accountId),
    toAccount: await accountOrNull(tx, userId, incoming.accountId),
  };
}

export interface TransferFields {
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  description?: string;
  note?: string;
}

/** The outgoing leg's id. */
export async function createTransfer(tx: Tx, userId: string, args: TransferFields): Promise<string> {
  return (await ledger.post(tx, userId, { type: "transfer", ...args })).id;
}

export type TransferChanges = ledger.TransferChanges;

export async function updateTransfer(tx: Tx, userId: string, id: string, changes: TransferChanges): Promise<string> {
  return await updateLoadedTransfer(tx, userId, await getTransfer(tx, userId, id, { editable: true }), changes);
}

/** The outgoing leg's id. */
export async function updateLoadedTransfer(tx: Tx, userId: string, transfer: Transfer, changes: TransferChanges): Promise<string> {
  return (await ledger.amend(tx, userId, transfer.entry, changes)).id;
}

/** Deletes both legs, or the one left of a legacy transfer. */
export async function deleteTransfer(tx: Tx, userId: string, id: string): Promise<void> {
  await ledger.reverse(tx, userId, [await ledger.open(tx, userId, id, "transfer")]);
}
