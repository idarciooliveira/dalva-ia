import { describe, expect, it } from "vitest";

import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { userProfiles as profilesTable } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as userProfiles from "./userProfiles";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

describe("domain/userProfiles", () => {
  it("creates, updates and completes a profile for the given user", async () => {
    const alice = await createTestUser();
    expect(await read((t) => userProfiles.getProfile(t, alice))).toBeNull();

    const created = await tx((t) => userProfiles.createProfile(t, alice, { baseCurrency: "USD" }));
    const again = await tx((t) => userProfiles.createProfile(t, alice, { baseCurrency: "EUR" }));
    expect(again.id).toBe(created.id);
    expect(await read((t) => userProfiles.getProfile(t, alice))).toMatchObject({
      userId: alice,
      baseCurrency: "EUR",
      onboardingCompleted: false,
    });

    await tx((t) => userProfiles.completeOnboarding(t, alice));
    // Going back in onboarding after completing it changes the currency only.
    await tx((t) => userProfiles.createProfile(t, alice, { baseCurrency: "AOA" }));
    expect(await read((t) => userProfiles.getProfile(t, alice))).toMatchObject({ baseCurrency: "AOA", onboardingCompleted: true });
    expect(await testDb().select().from(profilesTable)).toHaveLength(1);
  });

  describe("cross-user isolation", () => {
    it("never reads or completes another user's profile", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      await tx((t) => userProfiles.createProfile(t, alice, { baseCurrency: "USD" }));

      expect(await read((t) => userProfiles.getProfile(t, bob))).toBeNull();
      await expect(tx((t) => userProfiles.completeOnboarding(t, bob))).rejects.toThrow("Profile not found");
      expect(await read((t) => userProfiles.getProfile(t, alice))).toMatchObject({ onboardingCompleted: false });
    });
  });
});
