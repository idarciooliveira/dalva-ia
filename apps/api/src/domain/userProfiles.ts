/** User profile (base currency, onboarding state). */
import { eq } from "drizzle-orm";

import { userProfiles } from "../db/schema";
import type { Tx } from "../db/tx";
import { notFound } from "./errors";

export type UserProfile = typeof userProfiles.$inferSelect;

/** `null` until onboarding creates it. */
export async function getProfile(tx: Tx, userId: string): Promise<UserProfile | null> {
  const [profile] = await tx.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  return profile ?? null;
}

/** Create the profile, or only change its base currency when it exists (the user went back in onboarding). */
export async function createProfile(tx: Tx, userId: string, args: { baseCurrency: string }): Promise<UserProfile> {
  const [profile] = await tx
    .insert(userProfiles)
    .values({ userId, baseCurrency: args.baseCurrency })
    .onConflictDoUpdate({ target: userProfiles.userId, set: { baseCurrency: args.baseCurrency } })
    .returning();
  return profile!;
}

export async function completeOnboarding(tx: Tx, userId: string): Promise<UserProfile> {
  const [profile] = await tx
    .update(userProfiles)
    .set({ onboardingCompleted: true })
    .where(eq(userProfiles.userId, userId))
    .returning();
  if (!profile) throw notFound("Profile");
  return profile;
}
