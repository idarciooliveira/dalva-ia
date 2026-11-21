import { routes, type Money } from "@mpf/finance-contract";

import * as debtPayments from "../../domain/debtPayments";
import * as debts from "../../domain/debts";
import { apiError, notFound, validationError } from "./errors";
import { apiMutation, apiQuery } from "./define";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { appAmount, debtDto, debtPaymentDto, requireBaseCurrency, requireBaseCurrencyAccount, requireOwned } from "./shared";

export const list = apiQuery(routes.debts.list, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const docs = await debts.listDebts(ctx, userId, { includeArchived: input.includeArchived });
  return { items: docs.map((d) => debtDto(d, currency)) };
});

export const get = apiQuery(routes.debts.get, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.id, "id", "Debt");
  return { debt: debtDto(debt, await requireBaseCurrency(ctx, userId)) };
});

/* Web-only management ------------------------------------------------------ */

const debtResponse = async (ctx: MutationCtx, id: Id<"debts">, currency: string) => ({
  debt: debtDto((await ctx.db.get(id))!, currency),
});

type DebtMoney = Partial<Record<"originalAmount" | "currentBalance" | "minimumPayment", Money>>;

/** Request amounts (base currency) -> stored amounts, for the fields given. */
function debtAmounts(input: DebtMoney, currency: string) {
  const out: Partial<Record<keyof DebtMoney, number>> = {};
  for (const field of ["originalAmount", "currentBalance", "minimumPayment"] as const) {
    const money = input[field];
    if (money) out[field] = appAmount(money, currency, field);
  }
  return out;
}

export const create = apiMutation(routes.debts.create, async (ctx, userId, input) => {
  const currency = await requireBaseCurrency(ctx, userId);
  const { originalAmount, currentBalance, minimumPayment, linkedAccountId, ...fields } = input;
  const amounts = debtAmounts({ originalAmount, currentBalance, minimumPayment }, currency);
  const linked = linkedAccountId
    ? await requireBaseCurrencyAccount(ctx, userId, linkedAccountId, "linkedAccountId", currency)
    : undefined;
  const id = await debts.createDebt(ctx, userId, {
    ...fields,
    originalAmount: amounts.originalAmount!,
    currentBalance: amounts.currentBalance!,
    ...(amounts.minimumPayment !== undefined ? { minimumPayment: amounts.minimumPayment } : {}),
    ...(linked ? { linkedAccountId: linked._id } : {}),
  });
  return await debtResponse(ctx, id, currency);
});

export const update = apiMutation(routes.debts.update, async (ctx, userId, input) => {
  const { id, originalAmount, currentBalance, minimumPayment, linkedAccountId, ...fields } = input;
  const debt = await requireOwned(ctx, userId, "debts", id, "id", "Debt");
  const currency = await requireBaseCurrency(ctx, userId);
  const amounts = debtAmounts({ originalAmount, currentBalance, minimumPayment }, currency);
  // The web resends the current link on every edit: only a new link must be in the base currency
  // (debts created before this route may be linked to another currency).
  const linked =
    linkedAccountId && linkedAccountId !== (debt.linkedAccountId as string | undefined)
      ? await requireBaseCurrencyAccount(ctx, userId, linkedAccountId, "linkedAccountId", currency)
      : undefined;
  await debts.updateDebt(ctx, userId, { id: debt._id, ...fields, ...amounts, ...(linked ? { linkedAccountId: linked._id } : {}) });
  return await debtResponse(ctx, debt._id, currency);
});

export const archive = apiMutation(routes.debts.archive, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.id, "id", "Debt");
  const currency = await requireBaseCurrency(ctx, userId);
  await debts.archiveDebt(ctx, userId, { id: debt._id });
  return await debtResponse(ctx, debt._id, currency);
});

export const restore = apiMutation(routes.debts.restore, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.id, "id", "Debt");
  const currency = await requireBaseCurrency(ctx, userId);
  await debts.restoreDebt(ctx, userId, { id: debt._id });
  return await debtResponse(ctx, debt._id, currency);
});

export const remove = apiMutation(routes.debts.delete, async (ctx, userId, input) => {
  const debt = await requireOwned(ctx, userId, "debts", input.id, "id", "Debt");
  await debts.deleteDebt(ctx, userId, { id: debt._id });
  return { id: debt._id as string };
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
