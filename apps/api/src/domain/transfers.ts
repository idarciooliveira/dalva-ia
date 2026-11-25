import type { Tx } from "../db/tx";
import { type Account, getAccount } from "./accounts";
import { notFound } from "./errors";
import * as ledger from "./ledger";
import type { Money } from "./money";
import type { Transaction } from "./transactions";

/** Both legs with their accounts (null when a legacy leg lost its account). */
export interface Transfer {
  outgoing: Transaction;
  incoming: Transaction;
  fromAccount: Account | null;
  toAccount: Account | null;
}

async function accountOrNull(tx: Tx, userId: string, id: string | null): Promise<Account | null> {
  return id === null ? null : await getAccount(tx, userId, id);
}

/** The transfer either leg belongs to, whoever owns it. A leg whose pair is gone is `not_found`. */
export async function getTransfer(tx: Tx, userId: string, id: string): Promise<Transfer> {
  const { outgoing, incoming } = await ledger.open(tx, userId, id, "transfer", "read");
  if (!outgoing || !incoming) throw notFound("Transfer");
  return {
    outgoing,
    incoming,
    fromAccount: await accountOrNull(tx, userId, outgoing.accountId),
    toAccount: await accountOrNull(tx, userId, incoming.accountId),
  };
}

export interface TransferFields {
  /** Positive, in the accounts' one currency. */
  amount: Money;
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

/** The outgoing leg's id. `conflict` when a goal contribution owns the transfer; a leg whose pair is gone is `not_found`. */
export async function updateTransfer(tx: Tx, userId: string, id: string, changes: TransferChanges): Promise<string> {
  return (await ledger.amend(tx, userId, await ledger.open(tx, userId, id, "transfer"), changes)).id;
}

/** Deletes both legs, or the one left of a legacy transfer. */
export async function deleteTransfer(tx: Tx, userId: string, id: string): Promise<void> {
  await ledger.reverse(tx, userId, [await ledger.open(tx, userId, id, "transfer")]);
}
