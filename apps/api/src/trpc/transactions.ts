/**
 * Income, expense and adjustment rows. Every write moves the account balance
 * in the same transaction. Transfer legs, goal-contribution transfers and
 * debt-payment rows are `managedBy` something else: `update`/`delete` refuse
 * them (`conflict`).
 */
import { z } from "zod";

import { transactionType } from "../db/schema";
import * as accounts from "../domain/accounts";
import * as categories from "../domain/categories";
import { invalid, notFound } from "../domain/errors";
import { appAmount } from "../domain/money";
import * as transactions from "../domain/transactions";
import { transactionDtos } from "./currency";
import { transactionDto } from "./dto";
import { financeRead, financeWrite, router } from "./init";
import {
  byId,
  deleted,
  descriptionField,
  hasChangesBesidesId,
  idSchema,
  isoDateSchema,
  moneySchema,
  NO_CHANGES,
  nonZeroMoneySchema,
  noteField,
  payeeField,
  responseDate,
} from "./schemas";

export const transactionTypeSchema = z.enum(transactionType.enumValues);
/** Types the transaction procedures create and edit. Transfers have their own. */
export const writableTransactionTypeSchema = z.enum(["income", "expense", "adjustment"]);
export const transactionManagedBySchema = z.enum(["transfer", "goal_contribution", "debt_payment"]);

export const transactionSchema = z.object({
  id: z.string(),
  type: transactionTypeSchema,
  /** Positive for income/expense/transfer; signed for adjustments. Currency is the account's. */
  amount: moneySchema,
  accountId: z.string(),
  categoryId: z.string().optional(),
  subcategoryId: z.string().optional(),
  date: responseDate,
  description: z.string().optional(),
  note: z.string().optional(),
  payee: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Transfer legs only. `destinationAccountId` is set on the outgoing leg. */
  destinationAccountId: z.string().optional(),
  linkedTransactionId: z.string().optional(),
  transferGroupId: z.string().optional(),
});
const transactionResult = z.object({ transaction: transactionSchema });

const noCategoryOnAdjustments = (v: { type?: string; categoryId?: unknown; subcategoryId?: unknown }, ctx: z.RefinementCtx) => {
  if (v.categoryId) ctx.addIssue({ code: "custom", message: "Adjustments cannot have a category", path: ["categoryId"] });
  if (v.subcategoryId) ctx.addIssue({ code: "custom", message: "Adjustments cannot have a subcategory", path: ["subcategoryId"] });
};

export const transactionCreateInput = z
  .strictObject({
    type: writableTransactionTypeSchema,
    amount: nonZeroMoneySchema,
    accountId: idSchema,
    categoryId: idSchema.optional(),
    subcategoryId: idSchema.optional(),
    date: isoDateSchema,
    description: descriptionField.optional(),
    note: noteField.optional(),
    payee: payeeField.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "adjustment") noCategoryOnAdjustments(v, ctx);
    else if (v.amount.amountMinor < 0) ctx.addIssue({ code: "custom", message: "Amount must be positive", path: ["amount", "amountMinor"] });
  });

/**
 * Partial update; omitted fields are unchanged. `null` clears `subcategoryId`,
 * `description`, `note` and `payee`. The sign rule for `amount` depends on the
 * row's effective type, so the server enforces it (positive unless the result
 * is an adjustment).
 */
export const transactionUpdateInput = z
  .strictObject({
    id: idSchema,
    type: writableTransactionTypeSchema.optional(),
    amount: nonZeroMoneySchema.optional(),
    accountId: idSchema.optional(),
    categoryId: idSchema.optional(),
    subcategoryId: idSchema.nullable().optional(),
    date: isoDateSchema.optional(),
    description: descriptionField.nullable().optional(),
    note: noteField.nullable().optional(),
    payee: payeeField.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (!hasChangesBesidesId(v)) ctx.addIssue({ code: "custom", message: NO_CHANGES });
    if (v.type === "adjustment") noCategoryOnAdjustments(v, ctx);
    else if (v.type !== undefined && v.amount && v.amount.amountMinor < 0) {
      ctx.addIssue({ code: "custom", message: "Amount must be positive", path: ["amount", "amountMinor"] });
    }
  });

export const transactionDeleteInput = byId;

export const transactionsRouter = router({
  /**
   * Newest first, keyset-paged: pass the previous page's `nextCursor` (null on
   * the last page). Filtering by someone else's (or no) account or category is
   * `not_found`, not an empty page.
   */
  search: financeRead
    .input(
      z
        .strictObject({
          dateFrom: isoDateSchema.optional(),
          dateTo: isoDateSchema.optional(),
          accountId: idSchema.optional(),
          categoryId: idSchema.optional(),
          type: transactionTypeSchema.optional(),
          /** Free text over description, note and payee. */
          q: z.string().trim().min(1).max(200).optional(),
          cursor: z.string().min(1).max(512).optional(),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
          message: "dateFrom must not be after dateTo",
          path: ["dateFrom"],
        })
        .prefault({}),
    )
    .output(
      z.object({
        items: z.array(transactionSchema.extend({ managedBy: transactionManagedBySchema.optional() })),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { tx, user } = ctx;
      if (input.accountId) await accounts.getAccount(tx, user.userId, input.accountId);
      if (input.categoryId) await categories.getCategory(tx, user.userId, input.categoryId);
      const page = await transactions.searchTransactions(tx, user.userId, {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        accountId: input.accountId,
        categoryId: input.categoryId,
        type: input.type,
        q: input.q,
        cursor: input.cursor,
        limit: input.limit,
      });
      const items = await transactionDtos(tx, user.userId, page.items);
      const kinds = await transactions.managedKinds(tx, user.userId, page.items);
      return {
        items: items.map((item) => {
          const managedBy = kinds.get(item.id);
          return managedBy ? { ...item, managedBy } : item;
        }),
        nextCursor: page.nextCursor,
      };
    }),

  get: financeRead
    .input(byId)
    .output(z.object({ transaction: transactionSchema, managedBy: transactionManagedBySchema.optional() }))
    .query(async ({ ctx, input }) => {
      const { tx, user } = ctx;
      const row = await transactions.getTransaction(tx, user.userId, input.id);
      const [transaction] = await transactionDtos(tx, user.userId, [row]);
      // Goal contributions are transfers too: checked first, for the more specific label.
      const managedBy = (await transactions.ownedByContribution(tx, user.userId, row))
        ? ("goal_contribution" as const)
        : ((await transactions.managedTransactionKind(tx, user.userId, row)) ?? undefined);
      return { transaction: transaction!, ...(managedBy ? { managedBy } : {}) };
    }),

  create: financeWrite
    .input(transactionCreateInput)
    .output(transactionResult)
    .mutation(async ({ ctx, input }) => {
      const account = await accounts.getAccount(ctx.tx, ctx.user.userId, input.accountId);
      const row = await transactions.createTransaction(ctx.tx, ctx.user.userId, {
        type: input.type,
        amount: appAmount(input.amount, account.currency, "amount"),
        accountId: account.id,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
        date: input.date,
        description: input.description,
        note: input.note,
        payee: input.payee,
      });
      return { transaction: transactionDto(row, account.currency) };
    }),

  update: financeWrite
    .input(transactionUpdateInput)
    .output(transactionResult)
    .mutation(async ({ ctx, input }) => {
      const { tx, user } = ctx;
      const row = await transactions.getEditableTransaction(tx, user.userId, input.id);
      const targetId = input.accountId ?? row.accountId;
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
      // The sign rule needs the effective type, which the input schema can't see: the domain checks it.
      const updated = await transactions.updateLoadedTransaction(tx, user.userId, row, {
        type: input.type,
        amount,
        accountId: input.accountId === undefined ? undefined : account.id,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
        date: input.date,
        description: input.description,
        note: input.note,
        payee: input.payee,
      });
      return { transaction: transactionDto(updated, account.currency) };
    }),

  delete: financeWrite
    .input(transactionDeleteInput)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await transactions.deleteTransaction(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});
