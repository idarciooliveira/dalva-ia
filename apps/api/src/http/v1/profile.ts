import { routes } from "@mpf/finance-contract";

import * as userProfiles from "../../domain/userProfiles";
import { operation } from "../operation";
import { profileDto } from "./shared";

export const profileOperations = {
  get: operation(routes.profile.get, async (tx, user) => {
    const profile = await userProfiles.getProfile(tx, user.userId);
    return { profile: profile ? profileDto(profile) : null };
  }),

  create: operation(routes.profile.create, async (tx, user, input) => {
    return { profile: profileDto(await userProfiles.createProfile(tx, user.userId, { baseCurrency: input.baseCurrency })) };
  }),

  completeOnboarding: operation(routes.profile.completeOnboarding, async (tx, user) => {
    return { profile: profileDto(await userProfiles.completeOnboarding(tx, user.userId)) };
  }),
};
