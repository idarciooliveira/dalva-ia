import { describe, expect, it } from "vitest";
import * as userProfiles from "./domain/userProfiles";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

describe("domain/userProfiles", () => {
  it("creates, updates and completes a profile for the given user", async () => {
    const t = setupTest();
    expect(await t.run((ctx) => userProfiles.getProfile(ctx, ALICE))).toBeNull();

    const id = await t.run((ctx) => userProfiles.createProfile(ctx, ALICE, { baseCurrency: "USD" }));
    const again = await t.run((ctx) => userProfiles.createProfile(ctx, ALICE, { baseCurrency: "EUR" }));
    expect(again).toBe(id);
    expect(await t.run((ctx) => userProfiles.getProfile(ctx, ALICE))).toMatchObject({
      userId: ALICE,
      baseCurrency: "EUR",
      onboardingCompleted: false,
    });

    await t.run((ctx) => userProfiles.completeOnboarding(ctx, ALICE));
    expect(await t.run((ctx) => userProfiles.getProfile(ctx, ALICE))).toMatchObject({
      onboardingCompleted: true,
    });
  });

  describe("cross-user isolation", () => {
    it("never reads or completes another user's profile", async () => {
      const t = setupTest();
      await t.run((ctx) => userProfiles.createProfile(ctx, ALICE, { baseCurrency: "USD" }));

      expect(await t.run((ctx) => userProfiles.getProfile(ctx, BOB))).toBeNull();
      await expect(t.run((ctx) => userProfiles.completeOnboarding(ctx, BOB))).rejects.toThrow(
        "Profile not found",
      );
      expect(await t.run((ctx) => userProfiles.getProfile(ctx, ALICE))).toMatchObject({
        onboardingCompleted: false,
      });
    });
  });
});
