import { isUuid } from "../../db/ids";
import type { Account } from "../../domain/accounts";
import type { Category, Subcategory } from "../../domain/categories";
import { invalid } from "../../domain/errors";
import type { Transaction } from "../../domain/transactions";
import type { Transfer } from "../../domain/transfers";
import type { UserProfile } from "../../domain/userProfiles";
import { toMoney } from "./money";

/* Ids ---------------------------------------------------------------------- */

/** Contract-valid id -> row id. One that can't be a row id is `validation_failed`, as Convex's `normalizeId`. */
export function toId(value: string, field: string): string {
  if (!isUuid(value)) throw invalid(field, `Invalid ${field}`);
  return value;
}

/**
 * Stands in for the account of a legacy row whose account Convex deleted
 * (`account_id` is null, see the schema header). The contract requires an
 * account id; Convex returned the dangling id, which no lookup finds, and this
 * one behaves the same: `accounts.get` answers `not_found`.
 */
export const MISSING_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

/* Dates -------------------------------------------------------------------- */

export const todayUtc = () => new Date().toISOString().slice(0, 10);

/* DTOs: optional fields omitted (never null), `archived` only when true ----- */

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const accountDto = (a: Account) =>
  compact({
    id: a.id,
    name: a.name,
    type: a.type,
    balance: toMoney(a.balance, a.currency),
    theme: a.theme ?? undefined,
    icon: a.icon ?? undefined,
    description: a.description ?? undefined,
    archived: a.archived || undefined,
  });

export const profileDto = (p: UserProfile) =>
  compact({
    name: p.name ?? undefined,
    baseCurrency: p.baseCurrency,
    onboardingCompleted: p.onboardingCompleted,
  });

export const categoryDto = (c: Category) =>
  compact({
    id: c.id,
    name: c.name,
    type: c.type,
    icon: c.icon ?? undefined,
    color: c.color ?? undefined,
    isDefault: c.isDefault,
    archived: c.archived || undefined,
    sortOrder: c.sortOrder ?? undefined,
  });

/** `archived` is required on subcategories. */
export const subcategoryDto = (s: Subcategory) => ({
  id: s.id,
  categoryId: s.categoryId,
  name: s.name,
  archived: s.archived,
  sortOrder: s.sortOrder,
});

export const transactionDto = (t: Transaction, currency: string) =>
  compact({
    id: t.id,
    type: t.type,
    amount: toMoney(t.amount, currency),
    accountId: t.accountId ?? MISSING_ACCOUNT_ID,
    categoryId: t.categoryId ?? undefined,
    subcategoryId: t.subcategoryId ?? undefined,
    date: t.date,
    description: t.description ?? undefined,
    note: t.note ?? undefined,
    payee: t.payee ?? undefined,
    tags: t.tags ?? undefined,
    destinationAccountId: t.destinationAccountId ?? undefined,
    linkedTransactionId: t.linkedTransactionId ?? undefined,
    transferGroupId: t.transferGroupId ?? undefined,
  });

/** Both legs as one transfer, in the source account's currency ("Unknown" names a legacy leg's deleted account). */
export const transferDto = ({ outgoing, incoming, fromAccount, toAccount }: Transfer & { fromAccount: Account }) =>
  compact({
    outgoingId: outgoing.id,
    incomingId: incoming.id,
    transferGroupId: outgoing.transferGroupId ?? undefined,
    amount: toMoney(outgoing.amount, fromAccount.currency),
    fromAccountId: fromAccount.id,
    toAccountId: incoming.accountId ?? MISSING_ACCOUNT_ID,
    fromAccountName: fromAccount.name,
    toAccountName: toAccount?.name ?? "Unknown",
    date: outgoing.date,
    description: outgoing.description ?? undefined,
    note: outgoing.note ?? undefined,
  });
