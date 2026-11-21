import { routes } from "@mpf/finance-contract";

import * as accounts from "../../domain/accounts";
import * as categories from "../../domain/categories";
import { invalid, notFound } from "../../domain/errors";
import * as transactions from "../../domain/transactions";
import { operation } from "../operation";
import { transactionDtos } from "./currency";
import { appAmount } from "./money";
import { toId, transactionDto } from "./shared";

const optionalId = (value: string | undefined, field: string) => (value === undefined ? undefined : toId(value, field));

export const transactionOperations = {
  search: operation(routes.transactions.search, async (tx, user, input) => {
    const accountId = optionalId(input.accountId, "accountId");
    const categoryId = optionalId(input.categoryId, "categoryId");
    // Filtering by someone else's (or no) account or category is `not_found`, not an empty page.
    if (accountId) await accounts.getAccount(tx, user.userId, accountId);
    if (categoryId) await categories.getCategory(tx, user.userId, categoryId);
    const page = await transactions.searchTransactions(tx, user.userId, {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      accountId,
      categoryId,
      type: input.type,
      q: input.q,
      cursor: input.cursor,
      limit: input.limit,
    });
    return { items: await transactionDtos(tx, user.userId, page.items), nextCursor: page.nextCursor };
  }),

  get: operation(routes.transactions.get, async (tx, user, input) => {
    const row = await transactions.getTransaction(tx, user.userId, toId(input.id, "id"));
    const [transaction] = await transactionDtos(tx, user.userId, [row]);
    // Goal contributions are transfers too: checked first, for the more specific label.
    const managedBy = (await transactions.ownedByContribution(tx, user.userId, row))
      ? ("goal_contribution" as const)
      : ((await transactions.managedTransactionKind(tx, user.userId, row)) ?? undefined);
    return { transaction: transaction!, ...(managedBy ? { managedBy } : {}) };
  }),

  create: operation(routes.transactions.create, async (tx, user, input) => {
    const account = await accounts.getAccount(tx, user.userId, toId(input.accountId, "accountId"));
    const row = await transactions.createTransaction(tx, user.userId, {
      type: input.type,
      amount: appAmount(input.amount, account.currency, "amount"),
      accountId: account.id,
      categoryId: optionalId(input.categoryId, "categoryId"),
      subcategoryId: optionalId(input.subcategoryId, "subcategoryId"),
      date: input.date,
      description: input.description,
      note: input.note,
      payee: input.payee,
    });
    return { transaction: transactionDto(row, account.currency) };
  }),

  update: operation(routes.transactions.update, async (tx, user, input) => {
    const id = toId(input.id, "id");
    const row = await transactions.getEditableTransaction(tx, user.userId, id);
    const targetId = input.accountId === undefined ? row.accountId : toId(input.accountId, "accountId");
    if (targetId === null) throw notFound("Account");
    const account = await accounts.getAccount(tx, user.userId, targetId);

    // Amounts carry the account's currency: moving a row across currencies needs a new amount.
    let amount: number | undefined;
    if (input.amount) {
      amount = appAmount(input.amount, account.currency, "amount");
    } else if (row.accountId !== null && row.accountId !== account.id) {
      const previous = await accounts.getAccount(tx, user.userId, row.accountId);
      if (previous.currency !== account.currency) {
        throw invalid("amount", "Provide amount when moving a transaction to an account in another currency");
      }
    }
    // The sign rule needs the effective type, which the request schema can't see.
    if ((input.type ?? row.type) !== "adjustment" && (amount ?? row.amount) <= 0) {
      throw invalid("amount.amountMinor", "Amount must be positive");
    }

    const updated = await transactions.updateTransaction(tx, user.userId, id, {
      type: input.type,
      amount,
      accountId: input.accountId === undefined ? undefined : account.id,
      categoryId: optionalId(input.categoryId, "categoryId"),
      subcategoryId: optionalId(input.subcategoryId, "subcategoryId"),
      date: input.date,
      description: input.description,
      note: input.note,
      payee: input.payee,
    });
    return { transaction: transactionDto(updated, account.currency) };
  }),

  delete: operation(routes.transactions.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await transactions.deleteTransaction(tx, user.userId, id);
    return { id };
  }),
};
