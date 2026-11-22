import type { Account } from "@mpf/finance-contract";

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
