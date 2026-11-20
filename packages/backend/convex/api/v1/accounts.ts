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

export const create = apiMutation(routes.accounts.create, async (ctx, userId, input) => {
  const currency = input.balance.currency;
  const id = await accounts.createAccount(ctx, userId, {
    name: input.name,
    type: input.type,
    balance: appAmount(input.balance, currency, "balance"),
    currency,
    ...(input.theme ? { theme: input.theme } : {}),
  });
  return { account: accountDto(await accounts.getAccount(ctx, userId, { id })) };
});

export const update = apiMutation(routes.accounts.update, async (ctx, userId, input) => {
  const { id, ...fields } = input;
  const account = await requireOwned(ctx, userId, "accounts", id, "id", "Account");
  await accounts.updateAccount(ctx, userId, { id: account._id, ...fields });
  return { account: accountDto(await accounts.getAccount(ctx, userId, { id: account._id })) };
});

export const archive = apiMutation(routes.accounts.archive, async (ctx, userId, input) => {
  const account = await requireOwned(ctx, userId, "accounts", input.id, "id", "Account");
  await accounts.archiveAccount(ctx, userId, { id: account._id });
  return { account: accountDto(await accounts.getAccount(ctx, userId, { id: account._id })) };
});

export const restore = apiMutation(routes.accounts.restore, async (ctx, userId, input) => {
  const account = await requireOwned(ctx, userId, "accounts", input.id, "id", "Account");
  await accounts.restoreAccount(ctx, userId, { id: account._id });
  return { account: accountDto(await accounts.getAccount(ctx, userId, { id: account._id })) };
});

export const remove = apiMutation(routes.accounts.delete, async (ctx, userId, input) => {
  const account = await requireOwned(ctx, userId, "accounts", input.id, "id", "Account");
  await accounts.deleteAccount(ctx, userId, { id: account._id });
  return { id: account._id as string };
});
