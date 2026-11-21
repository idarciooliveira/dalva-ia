import { routes } from "@mpf/finance-contract";

import type { Tx } from "../../db/tx";
import * as accounts from "../../domain/accounts";
import { invalid, notFound } from "../../domain/errors";
import * as transfers from "../../domain/transfers";
import { operation } from "../operation";
import { appAmount } from "../../domain/money";
import { optionalId, toId, transferDto } from "./shared";

async function transferResponse(tx: Tx, userId: string, id: string) {
  const transfer = await transfers.getTransfer(tx, userId, id);
  // The amount is labelled with the source account's currency.
  if (!transfer.fromAccount) throw notFound("Account");
  return { transfer: transferDto({ ...transfer, fromAccount: transfer.fromAccount }) };
}

export const transferOperations = {
  get: operation(routes.transfers.get, async (tx, user, input) => {
    return await transferResponse(tx, user.userId, toId(input.id, "id"));
  }),

  create: operation(routes.transfers.create, async (tx, user, input) => {
    const from = await accounts.getAccount(tx, user.userId, toId(input.fromAccountId, "fromAccountId"));
    const to = await accounts.getAccount(tx, user.userId, toId(input.toAccountId, "toAccountId"));
    const currency = transfers.transferCurrency(from, to);
    const id = await transfers.createTransfer(tx, user.userId, {
      amount: appAmount(input.amount, currency, "amount"),
      fromAccountId: from.id,
      toAccountId: to.id,
      date: input.date,
      description: input.description,
      note: input.note,
    });
    return await transferResponse(tx, user.userId, id);
  }),

  update: operation(routes.transfers.update, async (tx, user, input) => {
    const id = toId(input.id, "id");
    const current = await transfers.getTransfer(tx, user.userId, id, { editable: true });
    const fromAccountId = optionalId(input.fromAccountId, "fromAccountId");
    const toAccountId = optionalId(input.toAccountId, "toAccountId");
    const from = fromAccountId ? await accounts.getAccount(tx, user.userId, fromAccountId) : current.fromAccount;
    const to = toAccountId ? await accounts.getAccount(tx, user.userId, toAccountId) : current.toAccount;
    if (!from || !to) throw notFound("Account");
    const currency = transfers.transferCurrency(from, to);

    let amount: number | undefined;
    if (input.amount) {
      amount = appAmount(input.amount, currency, "amount");
    } else if (current.fromAccount && current.fromAccount.currency !== currency) {
      throw invalid("amount", "Provide amount when moving a transfer to accounts in another currency");
    }

    const outgoingId = await transfers.updateLoadedTransfer(tx, user.userId, current, {
      amount,
      fromAccountId,
      toAccountId,
      date: input.date,
      description: input.description,
      note: input.note,
    });
    return await transferResponse(tx, user.userId, outgoingId);
  }),

  delete: operation(routes.transfers.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await transfers.deleteTransfer(tx, user.userId, id);
    return { id };
  }),
};
