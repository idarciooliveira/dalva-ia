/** Settings and onboarding state. One profile per user; absent until onboarding starts. */
import { z } from "zod";

import * as userProfiles from "../domain/userProfiles";
import { profileDto } from "./dto";
import { router, webRead, webWrite } from "./init";
import { currencyCodeSchema, noInput } from "./schemas";

export const profileSchema = z.object({
  name: z.string().optional(),
  /** ISO 4217 code: goals, debts and reports are in this currency. */
  baseCurrency: z.string(),
  onboardingCompleted: z.boolean(),
});
const profileResult = z.object({ profile: profileSchema });

export const profileRouter = router({
  /** `null` before onboarding has created the profile. */
  get: webRead
    .input(noInput)
    .output(z.object({ profile: profileSchema.nullable() }))
    .query(async ({ ctx }) => {
      const profile = await userProfiles.getProfile(ctx.tx, ctx.user.userId);
      return { profile: profile ? profileDto(profile) : null };
    }),

  /** Creates the profile, or changes its base currency if it exists (the user went back in onboarding). */
  create: webWrite
    .input(z.strictObject({ baseCurrency: currencyCodeSchema }))
    .output(profileResult)
    .mutation(async ({ ctx, input }) => ({
      profile: profileDto(await userProfiles.createProfile(ctx.tx, ctx.user.userId, { baseCurrency: input.baseCurrency })),
    })),

  /** `not_found` when there is no profile yet. */
  completeOnboarding: webWrite
    .input(noInput)
    .output(profileResult)
    .mutation(async ({ ctx }) => ({ profile: profileDto(await userProfiles.completeOnboarding(ctx.tx, ctx.user.userId)) })),
});
