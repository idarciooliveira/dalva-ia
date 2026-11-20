import { describe, expect, it } from "vitest";

import { clientFor, expectApiError, linkedChat, seedUser, setupApi, tokenFor } from "./test.helpers";

describe("api/v1 profile", () => {
  it("is null before onboarding, then created, re-created with a new currency and completed", async () => {
    const t = setupApi();
    const user = await seedUser(t, { profile: false });
    const client = clientFor(t, await tokenFor(user));

    expect(await client.profile.get()).toEqual({ profile: null });
    await expectApiError(client.profile.completeOnboarding(), "not_found", 404);

    expect(await client.profile.create({ baseCurrency: "USD" })).toEqual({
      profile: { baseCurrency: "USD", onboardingCompleted: false },
    });
    expect((await client.profile.create({ baseCurrency: "EUR" })).profile.baseCurrency).toBe("EUR");
    expect(await client.profile.completeOnboarding()).toEqual({
      profile: { baseCurrency: "EUR", onboardingCompleted: true },
    });
    expect((await client.profile.get()).profile).toEqual({ baseCurrency: "EUR", onboardingCompleted: true });
  });

  it("isolates users", async () => {
    const t = setupApi();
    const alice = await seedUser(t, { baseCurrency: "AOA" });
    const bob = await seedUser(t, { profile: false });
    expect((await clientFor(t, await tokenFor(alice)).profile.get()).profile?.baseCurrency).toBe("AOA");
    expect((await clientFor(t, await tokenFor(bob)).profile.get()).profile).toBeNull();
  });

  it("refuses chat tokens on the web-only routes", async () => {
    const t = setupApi();
    const chat = await linkedChat(t, { withAccount: true });
    const error = await expectApiError(chat.finance.profile.get(), "forbidden", 403);
    expect(error.message).toBe("Not available to chat tokens");
    await expectApiError(chat.finance.profile.create({ baseCurrency: "EUR" }), "forbidden", 403);
    await expectApiError(chat.finance.accounts.delete({ id: chat.accountId! }), "forbidden", 403);
    expect((await chat.finance.accounts.list()).items).toHaveLength(1);
  });
});
