import { routes } from "@mpf/finance-contract";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import * as transfers from "../../domain/transfers";
import { apiError, notFound, validationError } from "./errors";
import { apiMutation } from "./define";
import { toMoney } from "./money";
import { appAmount, owningContribution, requireOwned } from "./shared";

/** No currency conversion: both accounts must share one currency. */
function requireSameCurrency(from: Doc<"accounts">, to: Doc<"accounts">) {
  if (from.currency !== to.currency) {
    throw validationError("toAccountId", `Cross-currency transfers are not supported (${from.currency} -> ${to.currency})`);
  }
  return from.currency;
}

async function transferResponse(ctx: MutationCtx, userId: string, id: Id<"transactions">) {
  const view = await transfers.getTransfer(ctx, userId, { id });
  if (!view) throw notFound("Transfer");
  const from = await ctx.db.get(view.fromAccountId);
  if (!from) throw notFound("Account");
  const { amount, outgoingId, incomingId, fromAccountId, toAccountId, transferGroupId, description, note, ...rest } = view;
  return {
    transfer: {
      ...rest,
      outgoingId: outgoingId as string,
      incomingId: incomingId as string,
      fromAccountId: fromAccountId as string,
      toAccountId: toAccountId as string,
      amount: toMoney(amount, from.currency),
      ...(transferGroupId ? { transferGroupId } : {}),
      ...(description ? { description } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/** A user transfer leg; goal-contribution transfers belong to the contribution endpoints. */
async function requireTransfer(ctx: MutationCtx, userId: string, id: string) {
  const tx = await requireOwned(ctx, userId, "transactions", id, "id", "Transfer");
  if (tx.type !== "transfer") throw notFound("Transfer");
  if (await owningContribution(ctx, tx)) {
    throw apiError("conflict", "Goal contribution transfers must be changed through the goal contribution endpoints");
  }
  return tx;
}

export const create = apiMutation(routes.transfers.create, async (ctx, userId, input) => {
  const from = await requireOwned(ctx, userId, "accounts", input.fromAccountId, "fromAccountId", "Account");
  const to = await requireOwned(ctx, userId, "accounts", input.toAccountId, "toAccountId", "Account");
  const currency = requireSameCurrency(from, to);

  const { outgoingId } = await transfers.createTransfer(ctx, userId, {
    amount: appAmount(input.amount, currency, "amount"),
    fromAccountId: from._id,
    toAccountId: to._id,
    date: input.date,
    ...(input.description ? { description: input.description } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
  return await transferResponse(ctx, userId, outgoingId);
});

export const update = apiMutation(routes.transfers.update, async (ctx, userId, input) => {
  const tx = await requireTransfer(ctx, userId, input.id);
  const current = await transfers.getTransfer(ctx, userId, { id: tx._id });
  if (!current) throw notFound("Transfer");

  const from = await requireOwned(ctx, userId, "accounts", input.fromAccountId ?? current.fromAccountId, "fromAccountId", "Account");
  const to = await requireOwned(ctx, userId, "accounts", input.toAccountId ?? current.toAccountId, "toAccountId", "Account");
  if (from._id === to._id) throw validationError("toAccountId", "Cannot transfer to the same account");
  const currency = requireSameCurrency(from, to);

  let amount: number | undefined;
  if (input.amount) {
    amount = appAmount(input.amount, currency, "amount");
  } else {
    const previous = await ctx.db.get(current.fromAccountId);
    if (previous && previous.currency !== currency) {
      throw validationError("amount", "Provide amount when moving a transfer to accounts in another currency");
    }
  }

  await transfers.updateTransfer(ctx, userId, {
    id: tx._id,
    ...(amount !== undefined ? { amount } : {}),
    ...(input.fromAccountId ? { fromAccountId: from._id } : {}),
    ...(input.toAccountId ? { toAccountId: to._id } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
  return await transferResponse(ctx, userId, current.outgoingId);
});

/** `transfers.delete`. */
export const remove = apiMutation(routes.transfers.delete, async (ctx, userId, input) => {
  const tx = await requireTransfer(ctx, userId, input.id);
  await transfers.deleteTransfer(ctx, userId, { id: tx._id });
  return { id: tx._id as string };
});
