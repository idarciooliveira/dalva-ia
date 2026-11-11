import { routes } from "@mpf/finance-contract";

import * as debtPayments from "../../domain/debtPayments";
import * as debts from "../../domain/debts";
import { apiError, notFound, validationError } from "./errors";
import { apiMutation, apiQuery } from "./define";
import { appAmount, debtDto, debtPaymentDto, requireBaseCurrency, requireOwned } from "./shared";

export const list = apiQuery(routes.debts.list, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const docs = await debts.listDebts(ctx, userId, { includeArchived: input.includeArchived });
  return { items: docs.map((d) => debtDto(d, currency)) };
});

export const get = apiQuery(routes.debts.get, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.id, "id", "Debt");
  return { debt: debtDto(debt, await requireBaseCurrency(ctx, userId)) };
});

export const listPayments = apiQuery(routes.debtPayments.list, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.debtId, "debtId", "Debt");
  const currency = await requireBaseCurrency(ctx, userId);
  const docs = await debtPayments.listDebtPayments(ctx, userId, { debtId: debt._id });
  return { items: docs.map((p) => debtPaymentDto(p, currency)) };
});

/**
 * Debts are in the base currency; the payment leaves `fromAccountId` and, for
 * a linked debt, reduces the liability account, so all of them must match.
 */
export const recordPayment = apiMutation(routes.debtPayments.record, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.debtId, "debtId", "Debt");
  const from = await requireOwned(ctx, userId, "accounts", input.fromAccountId, "fromAccountId", "Account");
  const currency = await requireBaseCurrency(ctx, userId);
  if (from.currency !== currency) {
    throw validationError("fromAccountId", `Account currency ${from.currency} differs from the debt currency ${currency}`);
  }
  if (debt.linkedAccountId) {
    const liability = await ctx.db.get(debt.linkedAccountId);
    if (!liability || liability.userId !== userId) throw notFound("Linked account");
    if (liability.currency !== currency) {
      throw validationError("debtId", `Linked account currency ${liability.currency} differs from the debt currency ${currency}`);
    }
  }

  // Convert amount and principal, derive interest, so rounding can never break principal + interest = amount.
  const amount = appAmount(input.amount, currency, "amount");
  const principalAmount = input.principalAmount ? appAmount(input.principalAmount, currency, "principalAmount") : amount;
  const interestAmount = amount - principalAmount;
  if (interestAmount < 0) throw validationError("principalAmount", "Principal cannot exceed the payment amount");

  const id = await debtPayments.recordDebtPayment(ctx, userId, {
    debtId: debt._id,
    amount,
    principalAmount,
    interestAmount,
    date: input.date,
    fromAccountId: from._id,
    ...(input.note ? { note: input.note } : {}),
  });
  const payment = await ctx.db.get(id);
  if (!payment) throw apiError("internal", "Payment was not stored");
  return { payment: debtPaymentDto(payment, currency) };
});

export const removePayment = apiMutation(routes.debtPayments.remove, async (ctx, userId, input) => {
  const payment = await requireOwned(ctx, userId, "debtPayments", input.id, "id", "Debt payment");
  await debtPayments.removeDebtPayment(ctx, userId, { id: payment._id });
  return { id: payment._id as string };
});
