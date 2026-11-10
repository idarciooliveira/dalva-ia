import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * List all savings goals for the current user.
 * Excludes archived goals by default.
 */
export async function listGoals(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { includeArchived?: boolean },
) {
  const goals = await ctx.db
    .query("savingsGoals")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(100);

  if (args.includeArchived) return goals;

  return goals.filter((g) => !g.archived);
}

/**
 * Get a single savings goal by ID.
 * Validates ownership — throws "Goal not found" if the goal
 * doesn't exist or doesn't belong to the current user.
 */
export async function getGoal(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  args: { id: Id<"savingsGoals"> },
) {
  const goal = await ctx.db.get(args.id);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }
  return goal;
}

/**
 * Create a new savings goal for the current user.
 */
export async function createGoal(
  ctx: MutationCtx,
  userId: string,
  args: {
    name: string;
    targetAmount: number; // in minor units (cents)
    targetDate?: string; // ISO date
    linkedAccountId?: Id<"accounts">;
    isVirtual: boolean;
    icon?: string;
    color?: string;
  },
) {
  if (args.targetAmount <= 0) {
    throw new Error("Target amount must be positive");
  }

  // Validate linked account ownership if provided
  if (args.linkedAccountId) {
    const account = await ctx.db.get(args.linkedAccountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
  }

  return await ctx.db.insert("savingsGoals", {
    userId,
    name: args.name,
    targetAmount: args.targetAmount,
    currentAmount: 0,
    isVirtual: args.isVirtual,
    createdAt: new Date().toISOString().slice(0, 10),
    ...(args.targetDate ? { targetDate: args.targetDate } : {}),
    ...(args.linkedAccountId
      ? { linkedAccountId: args.linkedAccountId }
      : {}),
    ...(args.icon ? { icon: args.icon } : {}),
    ...(args.color ? { color: args.color } : {}),
  });
}

/**
 * Update an existing savings goal's editable fields.
 */
export async function updateGoal(
  ctx: MutationCtx,
  userId: string,
  args: {
    id: Id<"savingsGoals">;
    name?: string;
    targetAmount?: number;
    targetDate?: string;
    icon?: string;
    color?: string;
  },
) {
  const goal = await ctx.db.get(args.id);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }

  if (args.targetAmount !== undefined && args.targetAmount <= 0) {
    throw new Error("Target amount must be positive");
  }

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.targetAmount !== undefined) patch.targetAmount = args.targetAmount;
  if (args.targetDate !== undefined) patch.targetDate = args.targetDate;
  if (args.icon !== undefined) patch.icon = args.icon;
  if (args.color !== undefined) patch.color = args.color;

  await ctx.db.patch(args.id, patch);
}

/**
 * Archive a savings goal (soft-delete).
 */
export async function archiveGoal(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"savingsGoals"> },
) {
  const goal = await ctx.db.get(args.id);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }

  await ctx.db.patch(args.id, { archived: true });
}

/**
 * Restore an archived savings goal.
 */
export async function restoreGoal(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"savingsGoals"> },
) {
  const goal = await ctx.db.get(args.id);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }

  await ctx.db.patch(args.id, { archived: false });
}

/**
 * Permanently delete a savings goal and all its contributions.
 */
export async function deleteGoal(
  ctx: MutationCtx,
  userId: string,
  args: { id: Id<"savingsGoals"> },
) {
  const goal = await ctx.db.get(args.id);
  if (!goal || goal.userId !== userId) {
    throw new Error("Goal not found");
  }

  // Delete all contributions for this goal
  const contributions = await ctx.db
    .query("goalContributions")
    .withIndex("by_goalId", (q) => q.eq("goalId", args.id))
    .take(500);

  for (const c of contributions) {
    await ctx.db.delete(c._id);
  }

  await ctx.db.delete(args.id);
}

