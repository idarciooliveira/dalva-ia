/**
 * Which currency labels an amount. Account data is in the account's currency;
 * goals, debts and every report are in the user's base currency, and there is
 * no FX: a report is only answered when everything it sums is in that
 * currency.
 */
import { and, eq, inArray } from "drizzle-orm";

import { accounts } from "../db/schema";
import type { Tx } from "../db/tx";
import { conflict } from "../domain/errors";
import type { Transaction } from "../domain/transactions";
import { requireBaseCurrency } from "../domain/userProfiles";
import { transactionDto } from "./dto";

export const MIXED_CURRENCIES_MESSAGE = "Reports across multiple currencies are not supported yet";
export const UNKNOWN_CURRENCY_MESSAGE = "Report includes rows from a deleted account whose currency is unknown";

async function currenciesOf(tx: Tx, userId: string, accountIds: string[]): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.id, accountIds)));
  return new Map(rows.map((r) => [r.id, r.currency]));
}

/**
 * `conflict` unless every contributing account (and every currency given) is
 * the base currency: `mixed_currencies` with the currencies involved, or
 * `unknown_currency` when a summed row's account is gone (null).
 */
export async function requireBaseCurrencyOnly(
  tx: Tx,
  userId: string,
  baseCurrency: string,
  sources: { accountIds?: Array<string | null>; currencies?: string[] },
): Promise<void> {
  const accountIds = sources.accountIds ?? [];
  const live = accountIds.filter((id): id is string => id !== null);
  if (live.length < accountIds.length) throw conflict(UNKNOWN_CURRENCY_MESSAGE, { reason: "unknown_currency" });
  const known = await currenciesOf(tx, userId, [...new Set(live)]);
  const currencies = new Set([...(sources.currencies ?? []), ...known.values()]);
  if ([...currencies].every((c) => c === baseCurrency)) return;
  currencies.add(baseCurrency);
  throw conflict(MIXED_CURRENCIES_MESSAGE, { reason: "mixed_currencies", currencies: [...currencies].sort() });
}

/** Rows as DTOs in their account's currency; rows whose account is gone (legacy) in the base currency. */
export async function transactionDtos(tx: Tx, userId: string, rows: Transaction[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.accountId === null ? [] : [r.accountId])))];
  const currencies = await currenciesOf(tx, userId, ids);
  const base = rows.some((r) => r.accountId === null) ? await requireBaseCurrency(tx, userId) : undefined;
  return rows.map((r) => transactionDto(r, (r.accountId === null ? base : currencies.get(r.accountId))!));
}
