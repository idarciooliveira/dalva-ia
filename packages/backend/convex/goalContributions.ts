import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import * as goalContributionsDomain from "./domain/goalContributions";

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * List contributions for a specific savings goal.
 * Validates goal ownership.
 */
export const listContributions = query({
  args: { goalId: v.id("savingsGoals") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await goalContributionsDomain.listContributions(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Add a contribution to a savings goal.
 *
 * - For virtual goals: simply records the contribution and updates currentAmount.
 * - For linked goals: creates a transfer from `fromAccountId` to the goal's
 *   linked account, then records the contribution with the transfer's
 *   outgoing transaction ID.
 */
export const addContribution = mutation({
  args: {
    goalId: v.id("savingsGoals"),
    amount: v.number(), // in minor units (cents)
    date: v.string(), // ISO date
    note: v.optional(v.string()),
    fromAccountId: v.optional(v.id("accounts")), // required for linked goals
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await goalContributionsDomain.addContribution(ctx, userId, args);
  },
});

/**
 * Remove a contribution from a savings goal.
 *
 * - Decreases the goal's currentAmount.
 * - For linked goals: also deletes the associated transfer and reverses
 *   the balance effects on both accounts.
 */
export const removeContribution = mutation({
  args: { id: v.id("goalContributions") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await goalContributionsDomain.removeContribution(ctx, userId, args);
  },
});
