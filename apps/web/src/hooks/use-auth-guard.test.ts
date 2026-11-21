import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAuthGuard } from "./use-auth-guard";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));

type Result = { data?: unknown; isError?: boolean; isPending?: boolean; isSuccess?: boolean; error?: unknown; refetch?: () => void };
let session: Result;
let profile: Result;
vi.mock("@/hooks/use-session", () => ({ useSession: () => session }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => profile,
}));

const signedIn = { data: { id: "u1", name: "Ana Silva", email: "a@example.com" }, isSuccess: true, isPending: false, isError: false };
const onboarded = {
  data: { profile: { baseCurrency: "EUR", onboardingCompleted: true } },
  isSuccess: true,
  isPending: false,
  isError: false,
};

describe("useAuthGuard", () => {
  beforeEach(() => {
    navigate.mockReset();
    session = signedIn;
    profile = onboarded;
  });

  it("is ready with the profile and the session's name", () => {
    const { result } = renderHook(() => useAuthGuard({ requireOnboarding: true }));
    expect(result.current).toEqual({
      status: "ready",
      profile: { name: "Ana Silva", onboardingCompleted: true, baseCurrency: "EUR" },
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays ready when a background refetch fails but data is cached", () => {
    session = { ...signedIn, isError: true, error: new TypeError("Failed to fetch") };
    profile = { ...onboarded, isError: true, error: new Error("x") };
    const { result } = renderHook(() => useAuthGuard({ requireOnboarding: true }));
    expect(result.current.status).toBe("ready");
  });

  it("is an error when the first session check fails", () => {
    session = { isError: true, isPending: false, isSuccess: false, error: new TypeError("Failed to fetch"), refetch: vi.fn() };
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.status).toBe("error");
  });

  it("redirects signed-out users to /login", () => {
    session = { data: null, isSuccess: true, isPending: false, isError: false };
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.status).toBe("redirecting");
    expect(navigate).toHaveBeenCalledWith({ to: "/login" });
  });

  it("sends users who haven't finished onboarding there, and onboarded ones away from it", () => {
    profile = { data: { profile: null }, isSuccess: true, isPending: false, isError: false };
    const pending = renderHook(() => useAuthGuard({ requireOnboarding: true }));
    expect(pending.result.current.status).toBe("redirecting");
    expect(navigate).toHaveBeenCalledWith({ to: "/onboarding" });

    navigate.mockReset();
    profile = onboarded;
    const done = renderHook(() => useAuthGuard({ redirectIfOnboarded: true }));
    expect(done.result.current.status).toBe("redirecting");
    expect(navigate).toHaveBeenCalledWith({ to: "/dashboard" });
  });
});
