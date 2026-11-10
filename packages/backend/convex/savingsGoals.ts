import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as savingsGoalsDomain from "./domain/savingsGoals";

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * List all savings goals for the current user.
 * Excludes archived goals by default.
 */
export const listGoals = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return [];

    return await savingsGoalsDomain.listGoals(ctx, userId, args);
  },
});

/**
 * Get a single savings goal by ID.
 * Validates ownership — throws "Goal not found" if the goal
 * doesn't exist or doesn't belong to the current user.
 */
export const getGoal = query({
  args: { id: v.id("savingsGoals") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await savingsGoalsDomain.getGoal(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a new savings goal for the current user.
 */
export const createGoal = mutation({
  args: {
    name: v.string(),
    targetAmount: v.number(), // in minor units (cents)
    targetDate: v.optional(v.string()), // ISO date
    linkedAccountId: v.optional(v.id("accounts")),
    isVirtual: v.boolean(),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await savingsGoalsDomain.createGoal(ctx, userId, args);
  },
});

/**
 * Update an existing savings goal's editable fields.
 */
export const updateGoal = mutation({
  args: {
    id: v.id("savingsGoals"),
    name: v.optional(v.string()),
    targetAmount: v.optional(v.number()),
    targetDate: v.optional(v.string()),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await savingsGoalsDomain.updateGoal(ctx, userId, args);
  },
});

/**
 * Archive a savings goal (soft-delete).
 */
export const archiveGoal = mutation({
  args: { id: v.id("savingsGoals") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await savingsGoalsDomain.archiveGoal(ctx, userId, args);
  },
});

/**
 * Restore an archived savings goal.
 */
export const restoreGoal = mutation({
  args: { id: v.id("savingsGoals") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await savingsGoalsDomain.restoreGoal(ctx, userId, args);
  },
});

/**
 * Permanently delete a savings goal and all its contributions.
 */
export const deleteGoal = mutation({
  args: { id: v.id("savingsGoals") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await savingsGoalsDomain.deleteGoal(ctx, userId, args);
  },
});
