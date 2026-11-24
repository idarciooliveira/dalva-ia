import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "./api/keys";
import { resetDataOnUserChange, resetUserData } from "./auth-client";

const user = (id: string) => ({ id, name: id, email: `${id}@example.com` });
const accounts = { items: [{ id: "a-only", name: "A", type: "bank" as const, balance: { amountMinor: 0, currency: "USD" } }] };

function seeded() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.session(), user("a"));
  queryClient.setQueryData(queryKeys.accounts.list({}), accounts);
  queryClient.setQueryData(queryKeys.profile(), { profile: { baseCurrency: "USD", onboardingCompleted: true } });
  return queryClient;
}

describe("resetUserData", () => {
  it("drops every cached query but the session", async () => {
    const queryClient = seeded();
    await resetUserData(queryClient);
    expect(queryClient.getQueryData(queryKeys.accounts.list({}))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.profile())).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.session())).toEqual(user("a"));
  });
});

describe("resetDataOnUserChange", () => {
  it("resets data when the session's user changes, not when it stays the same", async () => {
    const queryClient = seeded();
    const stop = resetDataOnUserChange(queryClient);

    queryClient.setQueryData(queryKeys.session(), user("a"));
    queryClient.setQueryData(queryKeys.session(), { ...user("a") });
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(queryClient.getQueryData(queryKeys.accounts.list({}))).toEqual(accounts);

    // Another account signed in from another tab (shared cookie).
    queryClient.setQueryData(queryKeys.session(), user("b"));
    await vi.waitFor(() => expect(queryClient.getQueryData(queryKeys.accounts.list({}))).toBeUndefined());
    stop();
  });

  it("resets data on sign-out (user -> null)", async () => {
    const queryClient = seeded();
    const stop = resetDataOnUserChange(queryClient);
    queryClient.setQueryData(queryKeys.session(), user("a"));
    queryClient.setQueryData(queryKeys.session(), null);
    await vi.waitFor(() => expect(queryClient.getQueryData(queryKeys.profile())).toBeUndefined());
    stop();
  });
});
