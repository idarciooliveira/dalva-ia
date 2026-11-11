import type { Routes } from "@mpf/finance-contract";
import type { FunctionReference } from "convex/server";

import { internal } from "../../_generated/api";

/**
 * The contract widens `method` to `HttpMethod`, so query-vs-mutation can't be
 * checked here; GET routes must point at `apiQuery`, writes at `apiMutation`
 * (covered by router.test.ts).
 */
type Implementation = FunctionReference<"query" | "mutation", "internal">;

/**
 * Contract operation -> Convex implementation. Typed against the contract's
 * route map: a missing or extra entry is a compile error, so this cannot
 * drift from `routes`.
 */
export type Implementations = { [G in keyof Routes]: { [O in keyof Routes[G]]: Implementation } };

// Annotated, not `satisfies`: this module is part of `internal`'s own type, so
// an inferred type here would be circular.
export const implementations: Implementations = {
  accounts: {
    list: internal.api.v1.accounts.list,
    get: internal.api.v1.accounts.get,
    adjust: internal.api.v1.accounts.adjust,
  },
  categories: { list: internal.api.v1.categories.list },
  subcategories: { list: internal.api.v1.categories.listSubcategories },
  transactions: {
    search: internal.api.v1.transactions.search,
    create: internal.api.v1.transactions.create,
    update: internal.api.v1.transactions.update,
    delete: internal.api.v1.transactions.remove,
  },
  transfers: {
    create: internal.api.v1.transfers.create,
    update: internal.api.v1.transfers.update,
    delete: internal.api.v1.transfers.remove,
  },
  reports: {
    transactionSummary: internal.api.v1.reports.transactionSummary,
    spendingByCategory: internal.api.v1.reports.spendingByCategory,
    cashflow: internal.api.v1.reports.cashflow,
    netWorth: internal.api.v1.reports.netWorth,
    debtSummary: internal.api.v1.reports.debtSummary,
  },
  goals: {
    list: internal.api.v1.goals.list,
    get: internal.api.v1.goals.get,
  },
  goalContributions: {
    list: internal.api.v1.goals.listContributions,
    add: internal.api.v1.goals.addContribution,
    remove: internal.api.v1.goals.removeContribution,
  },
  debts: {
    list: internal.api.v1.debts.list,
    get: internal.api.v1.debts.get,
  },
  debtPayments: {
    list: internal.api.v1.debts.listPayments,
    record: internal.api.v1.debts.recordPayment,
    remove: internal.api.v1.debts.removePayment,
  },
};

export function implementationFor(group: string, op: string) {
  const ops = (implementations as Record<string, Record<string, Implementation>>)[group];
  return ops?.[op] ?? null;
}
