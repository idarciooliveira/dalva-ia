import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as transactionsDomain from "./domain/transactions";

/* -------------------------------------------------------------------------- */
/*  Shared validators                                                         */
/* -------------------------------------------------------------------------- */

const txTypeValidator = v.union(
  v.literal("income"),
  v.literal("expense"),
  v.literal("adjustment"),
  v.literal("transfer"),
);

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a new transaction and update the linked account's balance.
 */
export const createTransaction = mutation({
  args: {
    type: txTypeValidator,
    amount: v.number(),
    accountId: v.id("accounts"),
    categoryId: v.optional(v.id("categories")),
    subcategoryId: v.optional(v.id("subcategories")),
    date: v.string(),
    description: v.optional(v.string()),
    note: v.optional(v.string()),
    payee: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await transactionsDomain.createTransaction(ctx, userId, args);
  },
});

/**
 * Update a transaction. Reverses old balance effect and applies new one.
 */
export const updateTransaction = mutation({
  args: {
    id: v.id("transactions"),
    type: v.optional(txTypeValidator),
    amount: v.optional(v.number()),
    accountId: v.optional(v.id("accounts")),
    categoryId: v.optional(v.id("categories")),
    subcategoryId: v.optional(v.id("subcategories")),
    date: v.optional(v.string()),
    description: v.optional(v.string()),
    note: v.optional(v.string()),
    payee: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await transactionsDomain.updateTransaction(ctx, userId, args);
  },
});

/**
 * Delete a transaction and reverse its balance effect.
 */
export const deleteTransaction = mutation({
  args: { id: v.id("transactions") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await transactionsDomain.deleteTransaction(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * List transactions for the current user, sorted by date descending.
 * Supports optional filters (dateFrom, dateTo, accountId, categoryId, type).
 * Returns `{ page: [...] }` — no cursor-based pagination yet (uses .take()).
 */
export const listTransactions = query({
  args: {
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    categoryId: v.optional(v.id("categories")),
    type: v.optional(txTypeValidator),
    paginationOpts: v.optional(
      v.object({
        numItems: v.number(),
        cursor: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: null };

    return await transactionsDomain.listTransactions(ctx, userId, args);
  },
});

/**
 * Get a monthly transaction summary: total income, total expenses,
 * and recent transactions for the given month (format: "YYYY-MM").
 */
export const getTransactionSummary = query({
  args: { month: v.string() }, // e.g. "2026-04"
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) {
      return {
        totalIncome: 0,
        totalExpenses: 0,
        totalAdjustments: 0,
        recentTransactions: [],
      };
    }

    return await transactionsDomain.getTransactionSummary(ctx, userId, args);
  },
});

/**
 * Get spending aggregated by category for a given month.
 * Only includes expense transactions. Returns categories sorted by amount descending.
 */
export const getSpendingByCategory = query({
  args: { month: v.string() }, // e.g. "2026-04"
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) {
      return { categories: [], total: 0 };
    }

    return await transactionsDomain.getSpendingByCategory(ctx, userId, args);
  },
});

/**
 * Get cashflow data: income vs expenses for the current month plus a
 * configurable number of trailing months for the trend chart.
 */
export const getCashflow = query({
  args: {
    month: v.string(), // e.g. "2026-04"
    trendMonths: v.optional(v.number()), // how many months in the trend (default 6)
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) {
      return {
        currentMonth: { income: 0, expenses: 0, net: 0 },
        trend: [],
      };
    }

    return await transactionsDomain.getCashflow(ctx, userId, args);
  },
});
