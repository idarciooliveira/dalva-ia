import { routes } from "@mpf/finance-contract";

import * as accounts from "../../domain/accounts";
import { operation } from "../operation";
import { appAmount } from "../../domain/money";
import { accountDto, toId, todayUtc } from "./shared";

export const accountOperations = {
  list: operation(routes.accounts.list, async (tx, user, input) => {
    const rows = await accounts.listAccounts(tx, user.userId, { includeArchived: input.includeArchived });
    return { items: rows.map(accountDto) };
  }),

  get: operation(routes.accounts.get, async (tx, user, input) => {
    return { account: accountDto(await accounts.getAccount(tx, user.userId, toId(input.id, "id"))) };
  }),

  create: operation(routes.accounts.create, async (tx, user, input) => {
    const currency = input.balance.currency;
    const account = await accounts.createAccount(tx, user.userId, {
      name: input.name,
      type: input.type,
      balance: appAmount(input.balance, currency, "balance"),
      currency,
      theme: input.theme,
    });
    return { account: accountDto(account) };
  }),

  update: operation(routes.accounts.update, async (tx, user, input) => {
    const { id, ...fields } = input;
    return { account: accountDto(await accounts.updateAccount(tx, user.userId, toId(id, "id"), fields)) };
  }),

  archive: operation(routes.accounts.archive, async (tx, user, input) => {
    return { account: accountDto(await accounts.updateAccount(tx, user.userId, toId(input.id, "id"), { archived: true })) };
  }),

  restore: operation(routes.accounts.restore, async (tx, user, input) => {
    return { account: accountDto(await accounts.updateAccount(tx, user.userId, toId(input.id, "id"), { archived: false })) };
  }),

  delete: operation(routes.accounts.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await accounts.deleteAccount(tx, user.userId, id);
    return { id };
  }),

  adjust: operation(routes.accounts.adjust, async (tx, user, input) => {
    const id = toId(input.id, "id");
    const { currency } = await accounts.getAccount(tx, user.userId, id);
    const account = await accounts.adjustBalance(tx, user.userId, {
      id,
      amount: appAmount(input.amount, currency, "amount"),
      date: input.date ?? todayUtc(),
      note: input.note,
    });
    return { account: accountDto(account) };
  }),
};
