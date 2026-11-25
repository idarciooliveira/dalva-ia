/**
 * Debts and their payments, in the base currency. A payment is an expense on
 * the paying account plus, for a debt linked to a liability account, an
 * adjustment that pays it down. Fields can be changed, not cleared.
 */
import { z } from "zod";

import { debtType } from "../db/schema";
import * as debts from "../domain/debts";
import { requireBaseCurrency } from "../domain/userProfiles";
import { debtDto, debtPaymentDto } from "./dto";
import { financeRead, financeWrite, router, webWrite } from "./init";
import {
  byId,
  deleted,
  hasChangesBesidesId,
  idSchema,
  includeArchived,
  isoDateSchema,
  list,
  moneyInputSchema,
  moneySchema,
  nameField,
  NO_CHANGES,
  nonNegativeMoneySchema,
  noteField,
  positiveMoneySchema,
  responseDate,
} from "./schemas";

export const debtTypeSchema = z.enum(debtType.enumValues);

export const debtSchema = z.object({
  id: z.string(),
  name: z.string(),
  debtType: debtTypeSchema,
  lender: z.string().optional(),
  originalAmount: moneySchema,
  currentBalance: moneySchema,
  /** As stored by the app (the unit is not enforced). */
  interestRate: z.number().optional(),
  minimumPayment: moneySchema.optional(),
  dueDate: responseDate.optional(),
  linkedAccountId: z.string().optional(),
  archived: z.boolean().optional(),
  createdAt: responseDate,
});

export const debtPaymentSchema = z.object({
  id: z.string(),
  debtId: z.string(),
  amount: moneySchema,
  principalAmount: moneySchema,
  interestAmount: moneySchema,
  date: responseDate,
  note: z.string().optional(),
  fromAccountId: z.string(),
  sourceTransactionId: z.string(),
  liabilityTransactionId: z.string().optional(),
});

const debtResult = z.object({ debt: debtSchema });

const debtFields = {
  name: nameField,
  debtType: debtTypeSchema,
  lender: nameField.optional(),
  originalAmount: positiveMoneySchema,
  /** Remaining principal, at most `originalAmount`. */
  currentBalance: nonNegativeMoneySchema,
  /** Annual percentage as entered (e.g. 5.5). */
  interestRate: z.number().min(0).optional(),
  minimumPayment: nonNegativeMoneySchema.optional(),
  dueDate: isoDateSchema.optional(),
  /** Liability account whose balance payments pay down. */
  linkedAccountId: idSchema.optional(),
};

/** `principalAmount` defaults to `amount` and `interestAmount` to 0; they must add up to `amount`, in one currency. */
export const debtPaymentRecordInput = z
  .strictObject({
    debtId: idSchema,
    amount: positiveMoneySchema,
    principalAmount: moneyInputSchema.optional(),
    interestAmount: moneyInputSchema.optional(),
    date: isoDateSchema,
    note: noteField.optional(),
    fromAccountId: idSchema,
  })
  .superRefine((v, ctx) => {
    const { amount, principalAmount, interestAmount } = v;
    for (const field of ["principalAmount", "interestAmount"] as const) {
      const money = v[field];
      if (!money) continue;
      if (money.currency !== amount.currency) ctx.addIssue({ code: "custom", message: "Currency must match amount", path: [field, "currency"] });
      if (money.amountMinor < 0) ctx.addIssue({ code: "custom", message: "Must not be negative", path: [field, "amountMinor"] });
    }
    const principal = principalAmount?.amountMinor ?? amount.amountMinor;
    const interest = interestAmount?.amountMinor ?? 0;
    if (principal + interest !== amount.amountMinor) {
      ctx.addIssue({ code: "custom", message: "Principal and interest must add up to the payment amount", path: ["amount", "amountMinor"] });
    }
  });
export const debtPaymentRemoveInput = byId;

export const debtsRouter = router({
  list: financeRead
    .input(includeArchived)
    .output(list(debtSchema))
    .query(async ({ ctx: { tx, user }, input }) => {
      const currency = await requireBaseCurrency(tx, user.userId);
      const rows = await debts.listDebts(tx, user.userId, { includeArchived: input.includeArchived });
      return { items: rows.map((d) => debtDto(d, currency)) };
    }),

  get: financeRead
    .input(byId)
    .output(debtResult)
    .query(async ({ ctx: { tx, user }, input }) => {
      const debt = await debts.getDebt(tx, user.userId, input.id);
      return { debt: debtDto(debt, await requireBaseCurrency(tx, user.userId)) };
    }),

  /** `currentBalance` above `originalAmount` is `validation_failed`. */
  create: webWrite
    .input(
      z.strictObject(debtFields).superRefine((v, ctx) => {
        if (v.currentBalance.currency === v.originalAmount.currency && v.currentBalance.amountMinor > v.originalAmount.amountMinor) {
          ctx.addIssue({ code: "custom", message: "Current balance cannot exceed original amount", path: ["currentBalance", "amountMinor"] });
        }
      }),
    )
    .output(debtResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { debt, currency } = await debts.createDebt(tx, user.userId, input);
      return { debt: debtDto(debt, currency) };
    }),

  /**
   * Only the given fields change. The amounts are checked against the stored
   * ones (`currentBalance` at most `originalAmount`). Payments don't change
   * when the balance is edited by hand.
   */
  update: webWrite
    .input(
      z
        .strictObject({
          id: idSchema,
          name: debtFields.name.optional(),
          debtType: debtFields.debtType.optional(),
          lender: debtFields.lender,
          originalAmount: debtFields.originalAmount.optional(),
          currentBalance: debtFields.currentBalance.optional(),
          interestRate: debtFields.interestRate,
          minimumPayment: debtFields.minimumPayment,
          dueDate: debtFields.dueDate,
          linkedAccountId: debtFields.linkedAccountId,
        })
        .refine(hasChangesBesidesId, { message: NO_CHANGES }),
    )
    .output(debtResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { id, ...fields } = input;
      const { debt, currency } = await debts.updateDebt(tx, user.userId, id, fields);
      return { debt: debtDto(debt, currency) };
    }),

  /** Archived debts are hidden from `list` unless `includeArchived`, and left out of the reports. */
  archive: webWrite
    .input(byId)
    .output(debtResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const debt = await debts.setDebtArchived(tx, user.userId, input.id, true);
      return { debt: debtDto(debt, await requireBaseCurrency(tx, user.userId)) };
    }),

  restore: webWrite
    .input(byId)
    .output(debtResult)
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const debt = await debts.setDebtArchived(tx, user.userId, input.id, false);
      return { debt: debtDto(debt, await requireBaseCurrency(tx, user.userId)) };
    }),

  /** For good, with its payments and the transactions they created; their balance effects are reversed. */
  delete: webWrite
    .input(byId)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await debts.deleteDebt(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});

export const debtPaymentsRouter = router({
  list: financeRead
    .input(z.strictObject({ debtId: idSchema }))
    .output(list(debtPaymentSchema))
    .query(async ({ ctx: { tx, user }, input }) => {
      const rows = await debts.listDebtPayments(tx, user.userId, input.debtId);
      const currency = await requireBaseCurrency(tx, user.userId);
      return { items: rows.map((p) => debtPaymentDto(p, currency)) };
    }),

  /** Leaves `fromAccountId` and, for a linked debt, pays down the liability account: both in the base currency. */
  record: financeWrite
    .input(debtPaymentRecordInput)
    .output(z.object({ payment: debtPaymentSchema }))
    .mutation(async ({ ctx: { tx, user }, input }) => {
      const { payment, currency } = await debts.recordDebtPayment(tx, user.userId, input);
      return { payment: debtPaymentDto(payment, currency) };
    }),

  remove: financeWrite
    .input(debtPaymentRemoveInput)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await debts.removeDebtPayment(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});
