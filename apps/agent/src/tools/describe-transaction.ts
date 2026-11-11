import type { Transaction } from "@mpf/finance-contract";

import { categoryLabel, formatAmount, formatDay, quoted, shortText, type Language } from "../core/summary";
import type { Lookups } from "./proposals";

export interface RowParts {
  amount: string;
  category?: string;
  account?: string;
  date: string;
  payee?: string;
  description?: string;
}

/** Display parts of an existing row (amount, category, account, date, payee, description). */
export async function describeTransaction(look: Lookups, tx: Transaction, today: string, language: Language): Promise<RowParts> {
  const [account, names] = await Promise.all([
    look.account(tx.accountId).then(
      (a) => shortText(a.name),
      () => undefined,
    ),
    look.classificationNames(tx.categoryId, tx.subcategoryId),
  ]);
  return {
    amount: formatAmount(tx.amount.amountMinor, tx.amount.currency, language),
    category: categoryLabel(names.category, names.subcategory),
    account,
    date: formatDay(tx.date, today, language),
    payee: tx.payee ? shortText(tx.payee) : undefined,
    description: tx.description ? quoted(shortText(tx.description, 60)) : undefined,
  };
}

export const MANAGED_MESSAGES = {
  transfer: "This row is one leg of a transfer. Use delete_transfer to delete it; editing transfers is only possible in the DALVA app.",
  goal_contribution: "This row belongs to a savings-goal contribution. It can only be changed in the DALVA app (Goals).",
  debt_payment: "This row belongs to a debt payment. It can only be changed in the DALVA app (Debts).",
} as const;
