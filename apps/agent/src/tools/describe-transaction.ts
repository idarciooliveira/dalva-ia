import type { Transaction } from "@mpf/finance-contract";

import { categoryLabel, formatAmount, formatDay, quoted, shortText, type Language } from "../core/summary";
import type { Lookups } from "./proposals";

/** Summary parts that identify an existing row: amount · category · account · date · payee · description. */
export async function describeTransaction(look: Lookups, tx: Transaction, today: string, language: Language): Promise<Array<string | undefined>> {
  const [account, names] = await Promise.all([
    look.account(tx.accountId).then(
      (a) => shortText(a.name),
      () => undefined,
    ),
    look.classificationNames(tx.categoryId, tx.subcategoryId),
  ]);
  return [
    formatAmount(tx.amount.amountMinor, tx.amount.currency, language),
    categoryLabel(names.category, names.subcategory),
    account,
    formatDay(tx.date, today, language),
    tx.payee ? shortText(tx.payee) : undefined,
    tx.description ? quoted(tx.description) : undefined,
  ];
}

export const MANAGED_MESSAGES = {
  transfer: "This row is one leg of a transfer. Use delete_transfer to delete it; editing transfers is only possible in the DALVA app.",
  goal_contribution: "This row belongs to a savings-goal contribution. It can only be changed in the DALVA app (Goals).",
  debt_payment: "This row belongs to a debt payment. It can only be changed in the DALVA app (Debts).",
} as const;
