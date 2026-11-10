import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as transfersDomain from "./domain/transfers";

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a transfer between two accounts.
 *
 * This creates two linked "transfer" transactions:
 * - An outgoing transaction on the source account (debit)
 * - An incoming transaction on the destination account (credit)
 *
 * Both share the same `transferGroupId` and reference each other
 * via `linkedTransactionId`.
 */
export const createTransfer = mutation({
  args: {
    amount: v.number(),
    fromAccountId: v.id("accounts"),
    toAccountId: v.id("accounts"),
    date: v.string(),
    description: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await transfersDomain.createTransfer(ctx, userId, args);
  },
});

/**
 * Delete a transfer (both sides) and reverse balance effects.
 *
 * Can be called with either the outgoing or incoming transaction ID.
 */
export const deleteTransfer = mutation({
  args: { id: v.id("transactions") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await transfersDomain.deleteTransfer(ctx, userId, args);
  },
});

/**
 * Update a transfer. Updates both sides and adjusts balances.
 *
 * Can be called with either the outgoing or incoming transaction ID.
 * Supports updating: amount, fromAccountId, toAccountId, date, description, note.
 */
export const updateTransfer = mutation({
  args: {
    id: v.id("transactions"),
    amount: v.optional(v.number()),
    fromAccountId: v.optional(v.id("accounts")),
    toAccountId: v.optional(v.id("accounts")),
    date: v.optional(v.string()),
    description: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await transfersDomain.updateTransfer(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Get transfer details. Given either side's transaction ID, returns a unified
 * view of the transfer with account names.
 */
export const getTransfer = query({
  args: { id: v.id("transactions") },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return null;

    return await transfersDomain.getTransfer(ctx, userId, args);
  },
});
