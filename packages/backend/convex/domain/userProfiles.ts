import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Get the current user's profile.
 * Returns `null` if no profile has been created yet (pre-onboarding).
 */
export async function getProfile(
  ctx: QueryCtx | MutationCtx,
  userId: string,
) {
  return await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * Create a new profile for the authenticated user.
 * Called at the start of onboarding (Step 1 — currency selection).
 */
export async function createProfile(
  ctx: MutationCtx,
  userId: string,
  args: {
    baseCurrency: string;
  },
) {
  // Prevent duplicate profiles
  const existing = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

  if (existing) {
    // Update currency if profile already exists (user went back in wizard)
    await ctx.db.patch(existing._id, {
      baseCurrency: args.baseCurrency,
    });
    return existing._id;
  }

  return await ctx.db.insert("userProfiles", {
    userId,
    name: undefined,
    baseCurrency: args.baseCurrency,
    onboardingCompleted: false,
  });
}

/**
 * Mark onboarding as completed for the current user.
 * Called after the final onboarding step.
 */
export async function completeOnboarding(
  ctx: MutationCtx,
  userId: string,
) {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

  if (!profile) throw new Error("Profile not found");

  await ctx.db.patch(profile._id, { onboardingCompleted: true });
}

