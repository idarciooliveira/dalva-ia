import { routes, type Money } from "@mpf/finance-contract";

import * as debts from "../../domain/debts";
import { appAmount } from "../../domain/money";
import { invalid } from "../../domain/errors";
import { operation } from "../operation";
import { requireBaseCurrency, requireBaseCurrencyAccount } from "./currency";
import { debtDto, debtPaymentDto, optionalId, toId } from "./shared";

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

/** Debts and payments are in the base currency (Convex `api/v1/debts.ts`). */
export const debtOperations = {
  list: operation(routes.debts.list, async (tx, user, input) => {
    const currency = await requireBaseCurrency(tx, user.userId);
    const rows = await debts.listDebts(tx, user.userId, { includeArchived: input.includeArchived });
    return { items: rows.map((d) => debtDto(d, currency)) };
  }),

  get: operation(routes.debts.get, async (tx, user, input) => {
    const debt = await debts.getDebt(tx, user.userId, toId(input.id, "id"));
    return { debt: debtDto(debt, await requireBaseCurrency(tx, user.userId)) };
  }),

  create: operation(routes.debts.create, async (tx, user, input) => {
    const currency = await requireBaseCurrency(tx, user.userId);
    const amounts = debtAmounts(input, currency);
    const linkedAccountId = optionalId(input.linkedAccountId, "linkedAccountId");
    if (linkedAccountId) await requireBaseCurrencyAccount(tx, user.userId, linkedAccountId, "linkedAccountId", currency);
    const debt = await debts.createDebt(tx, user.userId, {
      name: input.name,
      debtType: input.debtType,
      lender: input.lender,
      originalAmount: amounts.originalAmount!,
      currentBalance: amounts.currentBalance!,
      interestRate: input.interestRate,
      minimumPayment: amounts.minimumPayment,
      dueDate: input.dueDate,
      linkedAccountId,
    });
    return { debt: debtDto(debt, currency) };
  }),

  update: operation(routes.debts.update, async (tx, user, input) => {
    const id = toId(input.id, "id");
    const current = await debts.getDebt(tx, user.userId, id);
    const currency = await requireBaseCurrency(tx, user.userId);
    const amounts = debtAmounts(input, currency);
    const linkedAccountId = optionalId(input.linkedAccountId, "linkedAccountId");
    // The web resends the current link on every edit: only a new link must be in the base currency
    // (Convex never checked, so an existing debt may be linked to another currency).
    if (linkedAccountId && linkedAccountId !== current.linkedAccountId) {
      await requireBaseCurrencyAccount(tx, user.userId, linkedAccountId, "linkedAccountId", currency);
    }
    const debt = await debts.updateDebt(tx, user.userId, id, {
      name: input.name,
      debtType: input.debtType,
      lender: input.lender,
      ...amounts,
      interestRate: input.interestRate,
      dueDate: input.dueDate,
      linkedAccountId,
    });
    return { debt: debtDto(debt, currency) };
  }),

  archive: operation(routes.debts.archive, async (tx, user, input) => {
    const debt = await debts.setDebtArchived(tx, user.userId, toId(input.id, "id"), true);
    return { debt: debtDto(debt, await requireBaseCurrency(tx, user.userId)) };
  }),

  restore: operation(routes.debts.restore, async (tx, user, input) => {
    const debt = await debts.setDebtArchived(tx, user.userId, toId(input.id, "id"), false);
    return { debt: debtDto(debt, await requireBaseCurrency(tx, user.userId)) };
  }),

  delete: operation(routes.debts.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await debts.deleteDebt(tx, user.userId, id);
    return { id };
  }),
};

export const debtPaymentOperations = {
  list: operation(routes.debtPayments.list, async (tx, user, input) => {
    const debtId = toId(input.debtId, "debtId");
    await debts.getDebt(tx, user.userId, debtId);
    const currency = await requireBaseCurrency(tx, user.userId);
    const rows = await debts.listDebtPayments(tx, user.userId, debtId);
    return { items: rows.map((p) => debtPaymentDto(p, currency)) };
  }),

  /**
   * The payment leaves `fromAccountId` and, for a linked debt, pays down the
   * liability account: both must be in the debt's (base) currency.
   */
  record: operation(routes.debtPayments.record, async (tx, user, input) => {
    const debt = await debts.getDebt(tx, user.userId, toId(input.debtId, "debtId"));
    const currency = await requireBaseCurrency(tx, user.userId);
    const from = await requireBaseCurrencyAccount(tx, user.userId, toId(input.fromAccountId, "fromAccountId"), "fromAccountId", currency, { owner: "debt" });
    if (debt.linkedAccountId) {
      await requireBaseCurrencyAccount(tx, user.userId, debt.linkedAccountId, "debtId", currency, { account: "Linked account", owner: "debt" });
    }

    // Convert amount and principal, derive interest, so rounding can never break principal + interest = amount.
    const amount = appAmount(input.amount, currency, "amount");
    const principalAmount = input.principalAmount ? appAmount(input.principalAmount, currency, "principalAmount") : amount;
    const interestAmount = amount - principalAmount;
    if (interestAmount < 0) throw invalid("principalAmount", "Principal cannot exceed the payment amount");

    const payment = await debts.recordDebtPayment(tx, user.userId, {
      debtId: debt.id,
      amount,
      principalAmount,
      interestAmount,
      date: input.date,
      note: input.note,
      fromAccountId: from.id,
    });
    return { payment: debtPaymentDto(payment, currency) };
  }),

  remove: operation(routes.debtPayments.remove, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await debts.removeDebtPayment(tx, user.userId, id);
    return { id };
  }),
};
