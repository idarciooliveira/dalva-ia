import { routes } from "@mpf/finance-contract";

import * as accounts from "../../domain/accounts";
import { apiMutation, apiQuery } from "./define";
import { accountDto, appAmount, requireOwned, todayUtc } from "./shared";

export const list = apiQuery(routes.accounts.list, async (ctx, userId, input) => {
  const docs = await accounts.listAccounts(ctx, userId, { includeArchived: input.includeArchived });
  return { items: docs.map(accountDto) };
});

export const get = apiQuery(routes.accounts.get, async (ctx, userId, input) => {
  const account = await requireOwned(ctx, userId, "accounts", input.id, "id", "Account");
  return { account: accountDto(account) };
});

export const adjust = apiMutation(routes.accounts.adjust, async (ctx, userId, input) => {
  const account = await requireOwned(ctx, userId, "accounts", input.id, "id", "Account");
  await accounts.adjustBalance(ctx, userId, {
    id: account._id,
    amount: appAmount(input.amount, account.currency, "amount"),
    date: input.date ?? todayUtc(),
    ...(input.note ? { note: input.note } : {}),
  });
  return { account: accountDto(await accounts.getAccount(ctx, userId, { id: account._id })) };
});
