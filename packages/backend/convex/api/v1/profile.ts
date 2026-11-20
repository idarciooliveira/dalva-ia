import { routes } from "@mpf/finance-contract";

import type { Doc } from "../../_generated/dataModel";
import * as userProfiles from "../../domain/userProfiles";
import { apiMutation, apiQuery } from "./define";
import { notFound } from "./errors";

const profileDto = (p: Doc<"userProfiles">) => ({
  ...(p.name !== undefined ? { name: p.name } : {}),
  baseCurrency: p.baseCurrency,
  onboardingCompleted: p.onboardingCompleted,
});

export const get = apiQuery(routes.profile.get, async (ctx, userId) => {
  const profile = await userProfiles.getProfile(ctx, userId);
  return { profile: profile ? profileDto(profile) : null };
});

export const create = apiMutation(routes.profile.create, async (ctx, userId, input) => {
  await userProfiles.createProfile(ctx, userId, { baseCurrency: input.baseCurrency });
  return { profile: profileDto((await userProfiles.getProfile(ctx, userId))!) };
});

export const completeOnboarding = apiMutation(routes.profile.completeOnboarding, async (ctx, userId) => {
  if (!(await userProfiles.getProfile(ctx, userId))) throw notFound("Profile");
  await userProfiles.completeOnboarding(ctx, userId);
  return { profile: profileDto((await userProfiles.getProfile(ctx, userId))!) };
});
