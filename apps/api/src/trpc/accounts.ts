/**
 * Accounts on `/api/trpc`: the same behaviour as `/api/v1/accounts`
 * (`src/http/v1/accounts.ts`), on the same domain code. Schemas live here;
 * clients get their types from `AppRouter`.
 */
import { z } from "zod";

import { accountType } from "../db/schema";
import * as accounts from "../domain/accounts";
import { appAmount } from "../domain/money";
import { accountDto, todayUtc } from "../http/v1/shared";
import { financeRead, financeWrite, router, webWrite } from "./init";
import { hasChangesBesidesId, idSchema, isoDateSchema, moneyInputSchema, moneySchema, NO_CHANGES, nonZeroMoneySchema, shortText } from "./schemas";

export const accountTypeSchema = z.enum(accountType.enumValues);

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  /** Signed; credit cards and loans are typically negative. */
  balance: moneySchema,
  theme: z.string().optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  /** Absent means not archived. */
  archived: z.boolean().optional(),
});

const accountResult = z.object({ account: accountSchema });
const byId = z.strictObject({ id: idSchema });
const accountName = shortText(100);
/** Visual theme id or Lucide icon name, as chosen in the app. */
const accountStyle = shortText(64);

export const accountsRouter = router({
  /** Archived accounts only with `includeArchived`. */
  list: financeRead
    .input(z.strictObject({ includeArchived: z.boolean().optional() }).optional())
    .output(z.object({ items: z.array(accountSchema) }))
    .query(async ({ ctx, input }) => {
      const rows = await accounts.listAccounts(ctx.tx, ctx.user.userId, { includeArchived: input?.includeArchived });
      return { items: rows.map(accountDto) };
    }),

  get: financeRead
    .input(byId)
    .output(accountResult)
    .query(async ({ ctx, input }) => ({ account: accountDto(await accounts.getAccount(ctx.tx, ctx.user.userId, input.id)) })),

  /** Signed delta on the balance, recorded as an `adjustment` transaction. The agent proposes these too. */
  adjust: financeWrite
    .input(
      z.strictObject({
        id: idSchema,
        amount: nonZeroMoneySchema,
        /** Defaults to today (server date). */
        date: isoDateSchema.optional(),
        note: shortText(1000).optional(),
      }),
    )
    .output(accountResult)
    .mutation(async ({ ctx, input }) => {
      const { currency } = await accounts.getAccount(ctx.tx, ctx.user.userId, input.id);
      const account = await accounts.adjustBalance(ctx.tx, ctx.user.userId, {
        id: input.id,
        amount: appAmount(input.amount, currency, "amount"),
        date: input.date ?? todayUtc(),
        note: input.note,
      });
      return { account: accountDto(account) };
    }),

  /** The opening balance's currency becomes the account's, which never changes. */
  create: webWrite
    .input(z.strictObject({ name: accountName, type: accountTypeSchema, balance: moneyInputSchema, theme: accountStyle.optional() }))
    .output(accountResult)
    .mutation(async ({ ctx, input }) => {
      const currency = input.balance.currency;
      const account = await accounts.createAccount(ctx.tx, ctx.user.userId, {
        name: input.name,
        type: input.type,
        balance: appAmount(input.balance, currency, "balance"),
        currency,
        theme: input.theme,
      });
      return { account: accountDto(account) };
    }),

  /** Only the given fields change. The currency and the balance can't be edited (`adjust`). */
  update: webWrite
    .input(
      z
        .strictObject({
          id: idSchema,
          name: accountName.optional(),
          type: accountTypeSchema.optional(),
          theme: accountStyle.optional(),
          icon: accountStyle.optional(),
          description: shortText(500).optional(),
        })
        .refine(hasChangesBesidesId, { message: NO_CHANGES }),
    )
    .output(accountResult)
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      return { account: accountDto(await accounts.updateAccount(ctx.tx, ctx.user.userId, id, fields)) };
    }),

  archive: webWrite
    .input(byId)
    .output(accountResult)
    .mutation(async ({ ctx, input }) => ({
      account: accountDto(await accounts.updateAccount(ctx.tx, ctx.user.userId, input.id, { archived: true })),
    })),

  restore: webWrite
    .input(byId)
    .output(accountResult)
    .mutation(async ({ ctx, input }) => ({
      account: accountDto(await accounts.updateAccount(ctx.tx, ctx.user.userId, input.id, { archived: false })),
    })),

  /** Only while nothing references the account (transactions, goals, debts); otherwise `conflict`: archive it instead. */
  delete: webWrite
    .input(byId)
    .output(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await accounts.deleteAccount(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});
