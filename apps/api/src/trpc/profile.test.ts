import { describe, expect, it } from "vitest";

import { clientFor, expectApiError, expectOk, raw, seedUser, tokenFor } from "../../test/api";
import { testApp } from "../../test/app";

describe("api/v1 profile", () => {
  it("is null before onboarding, then created, re-created with a new currency and completed", async () => {
    const { app } = testApp();
    const user = await seedUser({ profile: false });
    const client = clientFor(app, await tokenFor(user));

    expect(await client.profile.get()).toEqual({ profile: null });
    await expectApiError(client.profile.completeOnboarding(), "not_found", 404);

    expect(await client.profile.create({ baseCurrency: "USD" })).toEqual({
      profile: { baseCurrency: "USD", onboardingCompleted: false },
    });
    expect((await client.profile.create({ baseCurrency: "EUR" })).profile.baseCurrency).toBe("EUR");
    expect(await client.profile.completeOnboarding()).toEqual({ profile: { baseCurrency: "EUR", onboardingCompleted: true } });
    expectOk(await raw(app, "profile.get", undefined, { token: await tokenFor(user) }));
    expect((await client.profile.get()).profile).toEqual({ baseCurrency: "EUR", onboardingCompleted: true });
  });

  it("still changes the base currency after onboarding, as Convex does", async () => {
    const { app } = testApp();
    const client = clientFor(app, await tokenFor(await seedUser({ baseCurrency: "USD" })));
    expect(await client.profile.create({ baseCurrency: "EUR" })).toEqual({ profile: { baseCurrency: "EUR", onboardingCompleted: true } });
  });

  it("validates the currency code", async () => {
    const { app } = testApp();
    const token = await tokenFor(await seedUser({ profile: false }));
    for (const baseCurrency of ["usd", "DOLLAR", 840]) {
      const response = await raw(app, "profile.create", { baseCurrency }, { token, idempotencyKey: `profile-key-${baseCurrency}` });
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("validation_failed");
    }
    expect((await clientFor(app, token).profile.get()).profile).toBeNull();
  });

  it("isolates users", async () => {
    const { app } = testApp();
    const alice = await seedUser({ baseCurrency: "AOA" });
    const bob = await seedUser({ profile: false });
    const asBob = clientFor(app, await tokenFor(bob));
    expect((await clientFor(app, await tokenFor(alice)).profile.get()).profile?.baseCurrency).toBe("AOA");
    expect((await asBob.profile.get()).profile).toBeNull();
    await expectApiError(asBob.profile.completeOnboarding(), "not_found", 404);
  });
});
