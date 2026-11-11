import type { Money } from "@mpf/finance-contract";

import type { Doc, Id, TableNames } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { managedTransactionKind } from "../../domain/transactions";
import { getProfile } from "../../domain/userProfiles";
import { apiError, notFound, validationError } from "./errors";
import { minorToAppExact, MoneyPrecisionError, MoneyRangeError, toMoney } from "./money";

type Ctx = QueryCtx | MutationCtx;

/* -------------------------------------------------------------------------- */
/*  Ids and ownership                                                         */
/* -------------------------------------------------------------------------- */

/** Contract-valid string -> Convex id. A string that is not an id of `table` is `validation_failed`. */
export function toId<T extends TableNames>(ctx: Ctx, table: T, value: string, field: string): Id<T> {
  const id = ctx.db.normalizeId(table, value);
  if (!id) throw validationError(field, `Invalid ${field}`);
  return id;
}

type OwnedTable = "accounts" | "categories" | "subcategories" | "transactions" | "savingsGoals" | "goalContributions" | "debts" | "debtPayments";

/** Load a user-owned document; missing and foreign documents are both `not_found`. */
export async function requireOwned<T extends OwnedTable>(
  ctx: Ctx,
  userId: string,
  table: T,
  value: string,
  field: string,
  label: string,
): Promise<Doc<T>> {
  const doc = await ctx.db.get(toId(ctx, table, value, field));
  if (!doc || (doc as unknown as { userId: string }).userId !== userId) throw notFound(label);
  return doc as Doc<T>;
}

/* -------------------------------------------------------------------------- */
/*  Currency                                                                  */
/* -------------------------------------------------------------------------- */

/** Goals, debts and reports are in the user's base currency. */
export async function requireBaseCurrency(ctx: Ctx, userId: string): Promise<string> {
  const profile = await getProfile(ctx, userId);
  if (!profile) throw apiError("conflict", "User profile not found; complete onboarding first");
  return profile.baseCurrency;
}

/** Account currency per id, cached; orphaned rows (deleted account) fall back to the base currency. */
export function currencyResolver(ctx: Ctx, userId: string) {
  const cache = new Map<string, string>();
  let base: string | undefined;
  return async (accountId: Id<"accounts">): Promise<string> => {
    const cached = cache.get(accountId);
    if (cached) return cached;
    const account = await ctx.db.get(accountId);
    const currency =
      account && account.userId === userId ? account.currency : (base ??= await requireBaseCurrency(ctx, userId));
    cache.set(accountId, currency);
    return currency;
  };
}

export const MIXED_CURRENCIES_MESSAGE = "Reports across multiple currencies are not supported yet";
export const UNKNOWN_CURRENCY_MESSAGE = "Report includes rows from a deleted account whose currency is unknown";

/**
 * Aggregates are labelled with the base currency and there is no FX, so a
 * report is only honest when every contributing account is in that currency.
 * Otherwise `conflict` with the currencies involved; never an unconverted total.
 */
export async function requireBaseCurrencyOnly(
  ctx: Ctx,
  userId: string,
  baseCurrency: string,
  sources: { accountIds?: Iterable<Id<"accounts">>; currencies?: Iterable<string> },
) {
  const currencies = new Set<string>(sources.currencies ?? []);
  for (const accountId of new Set(sources.accountIds ?? [])) {
    const account = await ctx.db.get(accountId);
    // Deleted accounts leave their rows behind; their currency is unknown, so
    // the total can't be labelled with any currency.
    if (!account || account.userId !== userId) {
      throw apiError("conflict", UNKNOWN_CURRENCY_MESSAGE, { reason: "unknown_currency" });
    }
    currencies.add(account.currency);
  }
  if ([...currencies].every((c) => c === baseCurrency)) return;
  currencies.add(baseCurrency);
  throw apiError("conflict", MIXED_CURRENCIES_MESSAGE, { reason: "mixed_currencies", currencies: [...currencies].sort() });
}

export function assertCurrency(money: Money, expected: string, field: string) {
  if (money.currency !== expected) {
    throw validationError(`${field}.currency`, `Currency must be ${expected}, got ${money.currency}`);
  }
}

/** Contract money -> app amount, after the currency check. */
export function appAmount(money: Money, expected: string, field: string): number {
  assertCurrency(money, expected, field);
  let amount: number;
  try {
    amount = minorToAppExact(money.amountMinor, money.currency);
  } catch (error) {
    if (error instanceof MoneyRangeError) throw validationError(`${field}.amountMinor`, error.message);
    if (error instanceof MoneyPrecisionError) {
      // Never rounded: the stored amount must be the one the client sent (and the user confirmed).
      throw apiError("validation_failed", error.message, {
        reason: "precision",
        issues: [{ path: `${field}.amountMinor`, message: error.message }],
      });
    }
    throw error;
  }
  return amount;
}

/* -------------------------------------------------------------------------- */
/*  Managed rows                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Transfer legs (including goal-contribution transfers) and debt-payment rows
 * are owned by their own endpoints. Returns a reason when `tx` is one of them.
 */
export async function managedReason(ctx: Ctx, tx: Doc<"transactions">): Promise<string | null> {
  const kind = await managedTransactionKind(ctx, tx);
  if (kind === "transfer") return "Transfer legs must be changed through the transfer endpoints";
  if (kind === "debt_payment") return "Debt payment transactions must be changed through the debt payment endpoints";
  return null;
}

/** Goal contribution that owns this transfer (either leg), if any. */
export async function owningContribution(ctx: Ctx, tx: Doc<"transactions">) {
  for (const id of [tx._id, tx.linkedTransactionId]) {
    if (!id) continue;
    const contribution = await ctx.db
      .query("goalContributions")
      .withIndex("by_transactionId", (q) => q.eq("transactionId", id))
      .first();
    if (contribution) return contribution;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** `count` consecutive months ending at `month` (`YYYY-MM`), oldest first. */
export function monthsEndingAt(month: string, count: number): string[] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const total = year * 12 + index - (count - 1 - i);
    return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
  });
}

/* -------------------------------------------------------------------------- */
/*  DTO mappers (optional fields omitted, never undefined)                    */
/* -------------------------------------------------------------------------- */

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const accountDto = (a: Doc<"accounts">) =>
  compact({
    id: a._id as string,
    name: a.name,
    type: a.type,
    balance: toMoney(a.balance, a.currency),
    theme: a.theme,
    icon: a.icon,
    description: a.description,
    archived: a.archived,
  });

export const categoryDto = (c: Doc<"categories">) =>
  compact({
    id: c._id as string,
    name: c.name,
    type: c.type,
    icon: c.icon,
    color: c.color,
    isDefault: c.isDefault,
    archived: c.archived,
    sortOrder: c.sortOrder,
  });

export const subcategoryDto = (s: Doc<"subcategories">) => ({
  id: s._id as string,
  categoryId: s.categoryId as string,
  name: s.name,
  archived: s.archived,
  sortOrder: s.sortOrder,
});

export const transactionDto = (t: Doc<"transactions">, currency: string) =>
  compact({
    id: t._id as string,
    type: t.type,
    amount: toMoney(t.amount, currency),
    accountId: t.accountId as string,
    categoryId: t.categoryId as string | undefined,
    subcategoryId: t.subcategoryId as string | undefined,
    date: t.date,
    description: t.description,
    note: t.note,
    payee: t.payee,
    tags: t.tags,
    destinationAccountId: t.destinationAccountId as string | undefined,
    linkedTransactionId: t.linkedTransactionId as string | undefined,
    transferGroupId: t.transferGroupId,
  });

export async function transactionDtos(ctx: Ctx, userId: string, txs: Doc<"transactions">[]) {
  const currencyOf = currencyResolver(ctx, userId);
  const out = [];
  for (const tx of txs) out.push(transactionDto(tx, await currencyOf(tx.accountId)));
  return out;
}

export const goalDto = (g: Doc<"savingsGoals">, currency: string) =>
  compact({
    id: g._id as string,
    name: g.name,
    targetAmount: toMoney(g.targetAmount, currency),
    currentAmount: toMoney(g.currentAmount, currency),
    targetDate: g.targetDate,
    linkedAccountId: g.linkedAccountId as string | undefined,
    isVirtual: g.isVirtual,
    icon: g.icon,
    color: g.color,
    archived: g.archived,
    createdAt: g.createdAt,
  });

export const contributionDto = (c: Doc<"goalContributions">, currency: string) =>
  compact({
    id: c._id as string,
    goalId: c.goalId as string,
    amount: toMoney(c.amount, currency),
    date: c.date,
    note: c.note,
    transactionId: c.transactionId as string | undefined,
  });

export const debtDto = (d: Doc<"debts">, currency: string) =>
  compact({
    id: d._id as string,
    name: d.name,
    debtType: d.debtType,
    lender: d.lender,
    originalAmount: toMoney(d.originalAmount, currency),
    currentBalance: toMoney(d.currentBalance, currency),
    interestRate: d.interestRate,
    minimumPayment: d.minimumPayment === undefined ? undefined : toMoney(d.minimumPayment, currency),
    dueDate: d.dueDate,
    linkedAccountId: d.linkedAccountId as string | undefined,
    archived: d.archived,
    createdAt: d.createdAt,
  });

export const debtPaymentDto = (p: Doc<"debtPayments">, currency: string) =>
  compact({
    id: p._id as string,
    debtId: p.debtId as string,
    amount: toMoney(p.amount, currency),
    principalAmount: toMoney(p.principalAmount, currency),
    interestAmount: toMoney(p.interestAmount, currency),
    date: p.date,
    note: p.note,
    fromAccountId: p.fromAccountId as string,
    sourceTransactionId: p.sourceTransactionId as string,
    liabilityTransactionId: p.liabilityTransactionId as string | undefined,
  });
