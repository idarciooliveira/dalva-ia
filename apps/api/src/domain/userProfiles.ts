import { eq } from "drizzle-orm";

import { userProfiles } from "../db/schema";
import type { Tx } from "../db/tx";
import { conflict, notFound } from "./errors";

export type UserProfile = typeof userProfiles.$inferSelect;

export async function getProfile(tx: Tx, userId: string): Promise<UserProfile | null> {
  const [profile] = await tx.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  return profile ?? null;
}

/** The user's base currency, which goals, debts and reports are in; `conflict` before onboarding created the profile. */
export async function requireBaseCurrency(tx: Tx, userId: string): Promise<string> {
  const profile = await getProfile(tx, userId);
  if (!profile) throw conflict("User profile not found; complete onboarding first");
  return profile.baseCurrency;
}

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
