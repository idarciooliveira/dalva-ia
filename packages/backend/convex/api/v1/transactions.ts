import { routes } from "@mpf/finance-contract";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import * as transactions from "../../domain/transactions";
import { apiError, notFound, validationError } from "./errors";
import { apiMutation, apiQuery } from "./define";
import { appAmount, managedReason, requireOwned, transactionDto, transactionDtos } from "./shared";

export const search = apiQuery(routes.transactions.search, async (ctx, userId, input) => {
  const account = input.accountId
    ? await requireOwned(ctx, userId, "accounts", input.accountId, "accountId", "Account")
    : null;
  const category = input.categoryId
    ? await requireOwned(ctx, userId, "categories", input.categoryId, "categoryId", "Category")
    : null;

  const page = await transactions.searchTransactions(ctx, userId, {
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    accountId: account?._id,
    categoryId: category?._id,
    type: input.type,
    q: input.q,
    cursor: input.cursor,
    limit: input.limit,
  });
  return { items: await transactionDtos(ctx, userId, page.items), nextCursor: page.nextCursor };
});

/** Category/subcategory must be the user's, and the subcategory must sit under the category. */
async function resolveClassification(
  ctx: MutationCtx,
  userId: string,
  input: { categoryId?: string; subcategoryId?: string },
  existing?: Doc<"transactions">,
) {
  const category = input.categoryId
    ? await requireOwned(ctx, userId, "categories", input.categoryId, "categoryId", "Category")
    : null;
  const subcategory = input.subcategoryId
    ? await requireOwned(ctx, userId, "subcategories", input.subcategoryId, "subcategoryId", "Subcategory")
    : null;
  const effectiveCategoryId = category?._id ?? existing?.categoryId;
  if (subcategory && subcategory.categoryId !== effectiveCategoryId) {
    throw validationError("subcategoryId", "Subcategory does not belong to the category");
  }
  return { categoryId: category?._id, subcategoryId: subcategory?._id };
}

async function reread(ctx: MutationCtx, id: Id<"transactions">) {
  const tx = await ctx.db.get(id);
  if (!tx) throw notFound("Transaction");
  const account = await ctx.db.get(tx.accountId);
  if (!account) throw notFound("Account");
  return { transaction: transactionDto(tx, account.currency) };
}

export const create = apiMutation(routes.transactions.create, async (ctx, userId, input) => {
  const account = await requireOwned(ctx, userId, "accounts", input.accountId, "accountId", "Account");
  const { categoryId, subcategoryId } = await resolveClassification(ctx, userId, input);

  const id = await transactions.createTransaction(ctx, userId, {
    type: input.type,
    amount: appAmount(input.amount, account.currency, "amount"),
    accountId: account._id,
    date: input.date,
    ...(categoryId ? { categoryId } : {}),
    ...(subcategoryId ? { subcategoryId } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.payee ? { payee: input.payee } : {}),
  });
  return await reread(ctx, id);
});

async function requireEditable(ctx: MutationCtx, userId: string, id: string) {
  const tx = await requireOwned(ctx, userId, "transactions", id, "id", "Transaction");
  const reason = await managedReason(ctx, tx);
  if (reason) throw apiError("conflict", reason);
  return tx;
}

export const update = apiMutation(routes.transactions.update, async (ctx, userId, input) => {
  const tx = await requireEditable(ctx, userId, input.id);
  const account = input.accountId
    ? await requireOwned(ctx, userId, "accounts", input.accountId, "accountId", "Account")
    : await ctx.db.get(tx.accountId);
  if (!account) throw notFound("Account");
  const { categoryId, subcategoryId } = await resolveClassification(ctx, userId, input, tx);

  // Amounts carry the account's currency; moving a row across currencies needs a new amount.
  let amount: number | undefined;
  if (input.amount) {
    amount = appAmount(input.amount, account.currency, "amount");
  } else if (account._id !== tx.accountId) {
    const previous = await ctx.db.get(tx.accountId);
    if (previous && previous.currency !== account.currency) {
      throw validationError("amount", "Provide amount when moving a transaction to an account in another currency");
    }
  }

  // Sign rule against the effective type: positive unless the result is an adjustment.
  const effectiveType = input.type ?? tx.type;
  const effectiveAmount = amount ?? tx.amount;
  if (effectiveType !== "adjustment" && effectiveAmount <= 0) {
    throw validationError("amount.amountMinor", "Amount must be positive");
  }

  await transactions.updateTransaction(ctx, userId, {
    id: tx._id,
    ...(input.type ? { type: input.type } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(input.accountId ? { accountId: account._id } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(subcategoryId ? { subcategoryId } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.payee ? { payee: input.payee } : {}),
  });
  // A new category without a subcategory: the old subcategory belongs to the
  // old category and the contract can't clear fields, so drop it here.
  if (categoryId && categoryId !== tx.categoryId && !subcategoryId && tx.subcategoryId) {
    await ctx.db.patch(tx._id, { subcategoryId: undefined });
  }
  return await reread(ctx, tx._id);
});

/** `transactions.delete` (`delete` is not a usable function name). */
export const remove = apiMutation(routes.transactions.delete, async (ctx, userId, input) => {
  const tx = await requireEditable(ctx, userId, input.id);
  await transactions.deleteTransaction(ctx, userId, { id: tx._id });
  return { id: tx._id as string };
});
