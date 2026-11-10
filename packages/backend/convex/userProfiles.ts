import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as userProfilesDomain from "./domain/userProfiles";

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Get the current user's profile.
 * Returns `null` if no profile has been created yet (pre-onboarding).
 */
export const getProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return null;

    return await userProfilesDomain.getProfile(ctx, userId);
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a new profile for the authenticated user.
 * Called at the start of onboarding (Step 1 — currency selection).
 */
export const createProfile = mutation({
  args: {
    baseCurrency: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await userProfilesDomain.createProfile(ctx, userId, args);
  },
});

/**
 * Mark onboarding as completed for the current user.
 * Called after the final onboarding step.
 */
export const completeOnboarding = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await userProfilesDomain.completeOnboarding(ctx, userId);
  },
});
