import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as accountsDomain from "./domain/accounts";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const accountTypeValidator = v.union(
  v.literal("bank"),
  v.literal("savings"),
  v.literal("credit_card"),
  v.literal("cash"),
  v.literal("e_wallet"),
  v.literal("loan"),
  v.literal("investment"),
);

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * List all accounts for the current user.
 * Excludes archived accounts by default.
 */
export const listAccounts = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return [];

    return await accountsDomain.listAccounts(ctx, userId, args);
  },
});

/**
 * Get a single account by ID.
 * Validates ownership — throws "Account not found" if the account
 * doesn't exist or doesn't belong to the current user.
 */
export const getAccount = query({
  args: { id: v.id("accounts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await accountsDomain.getAccount(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a new financial account for the current user.
 */
export const createAccount = mutation({
  args: {
    name: v.string(),
    type: accountTypeValidator,
    balance: v.number(), // in minor units (cents)
    currency: v.string(), // ISO 4217
    theme: v.optional(v.string()), // visual theme id
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await accountsDomain.createAccount(ctx, userId, args);
  },
});

/**
 * Update an existing account's editable fields.
 */
export const updateAccount = mutation({
  args: {
    id: v.id("accounts"),
    name: v.optional(v.string()),
    type: v.optional(accountTypeValidator),
    theme: v.optional(v.string()),
    icon: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await accountsDomain.updateAccount(ctx, userId, args);
  },
});

/**
 * Archive an account (soft-delete).
 */
export const archiveAccount = mutation({
  args: { id: v.id("accounts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await accountsDomain.archiveAccount(ctx, userId, args);
  },
});

/**
 * Restore an archived account.
 */
export const restoreAccount = mutation({
  args: { id: v.id("accounts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await accountsDomain.restoreAccount(ctx, userId, args);
  },
});

/**
 * Permanently delete an account.
 */
export const deleteAccount = mutation({
  args: { id: v.id("accounts") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await accountsDomain.deleteAccount(ctx, userId, args);
  },
});

/**
 * Adjust an account's balance by a delta (positive or negative, in cents).
 * Used for manual balance corrections / reconciliation.
 */
export const adjustBalance = mutation({
  args: {
    id: v.id("accounts"),
    amount: v.number(), // delta in cents (positive = add, negative = subtract)
    date: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await accountsDomain.adjustBalance(ctx, userId, args);
  },
});
