import type { Account, Transaction } from "@mpf/finance-contract";

import { ACCOUNT_THEMES } from "@/lib/accounts";

/** Local "YYYY-MM-DD", `daysAgo` days back. */
export function localISODate(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type DatePreset = "today" | "yesterday" | "other";

export function getDatePreset(date: string): DatePreset {
  if (date === localISODate(0)) return "today";
  if (date === localISODate(1)) return "yesterday";
  return "other";
}

/** Accounts a form can pick: active ones, plus the archived ones the record already uses. */
export function selectableAccounts(accounts: Account[] | undefined, keep: ReadonlyArray<string | undefined>): Account[] {
  return (accounts ?? []).filter((a) => !a.archived || keep.includes(a.id));
}

export function accountTheme(account: Pick<Account, "theme">) {
  return ACCOUNT_THEMES.find((t) => t.id === (account.theme ?? "default")) ?? ACCOUNT_THEMES[0];
}

interface TransactionDraft {
  type: "income" | "expense";
  amount: { amountMinor: number; currency: string };
  accountId: string;
  date: string;
  /** "" when none is picked. */
  categoryId: string;
  subcategoryId: string;
  description: string;
  note: string;
  payee: string;
}

/**
 * Only what the form changed, so a value changed elsewhere since the row was
 * listed (another tab, the Telegram agent) isn't written back. An emptied text
 * field or subcategory is sent as `null`, which clears it. Removing the
 * category is refused before this runs.
 */
export function transactionChanges(original: Transaction, draft: TransactionDraft) {
  const changes: {
    type?: "income" | "expense";
    amount?: { amountMinor: number; currency: string };
    accountId?: string;
    date?: string;
    categoryId?: string;
    subcategoryId?: string | null;
    description?: string | null;
    note?: string | null;
    payee?: string | null;
  } = {};
  if (draft.type !== original.type) changes.type = draft.type;
  // A move to another account always carries the amount: it may be in another currency.
  if (
    draft.accountId !== original.accountId ||
    draft.amount.amountMinor !== original.amount.amountMinor ||
    draft.amount.currency !== original.amount.currency
  ) {
    changes.amount = draft.amount;
  }
  if (draft.accountId !== original.accountId) changes.accountId = draft.accountId;
  if (draft.date !== original.date) changes.date = draft.date;
  const categoryChanged = draft.categoryId !== (original.categoryId ?? "");
  if (categoryChanged && draft.categoryId) changes.categoryId = draft.categoryId;
  if (draft.subcategoryId !== (original.subcategoryId ?? "")) {
    if (draft.subcategoryId) changes.subcategoryId = draft.subcategoryId;
    // A new category already drops the old subcategory.
    else if (!categoryChanged) changes.subcategoryId = null;
  }
  for (const field of ["description", "note", "payee"] as const) {
    const next = draft[field].trim();
    if (next !== (original[field] ?? "").trim()) changes[field] = next === "" ? null : next;
  }
  return changes;
}

/** The same for a transfer: only changed fields, emptied description or note as `null`. */
export function transferChanges(
  original: { amount: { amountMinor: number; currency: string }; fromAccountId: string; toAccountId: string; date: string; description?: string; note?: string },
  draft: { amount: { amountMinor: number; currency: string }; fromAccountId: string; toAccountId: string; date: string; description: string; note: string },
) {
  const changes: {
    amount?: { amountMinor: number; currency: string };
    fromAccountId?: string;
    toAccountId?: string;
    date?: string;
    description?: string | null;
    note?: string | null;
  } = {};
  const accountsChanged = draft.fromAccountId !== original.fromAccountId || draft.toAccountId !== original.toAccountId;
  if (
    accountsChanged ||
    draft.amount.amountMinor !== original.amount.amountMinor ||
    draft.amount.currency !== original.amount.currency
  ) {
    changes.amount = draft.amount;
  }
  if (draft.fromAccountId !== original.fromAccountId) changes.fromAccountId = draft.fromAccountId;
  if (draft.toAccountId !== original.toAccountId) changes.toAccountId = draft.toAccountId;
  if (draft.date !== original.date) changes.date = draft.date;
  for (const field of ["description", "note"] as const) {
    const next = draft[field].trim();
    if (next !== (original[field] ?? "").trim()) changes[field] = next === "" ? null : next;
  }
  return changes;
}
