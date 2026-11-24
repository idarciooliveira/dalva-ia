import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { profileQuery } from "@/lib/api/queries";
import { useSession } from "@/hooks/use-session";

interface AuthGuardOptions {
  /** Where to redirect if the user is not authenticated. Defaults to "/login". */
  unauthenticatedRedirect?: string;
  /** If true, requires onboarding to be completed (redirects to "/onboarding" otherwise). */
  requireOnboarding?: boolean;
  /** If true, redirects to "/dashboard" when onboarding IS completed (for the onboarding page itself). */
  redirectIfOnboarded?: boolean;
}

export type AuthGuardResult =
  | { status: "loading" }
  | { status: "redirecting" }
  /** The session or the profile couldn't be read (API down, network). */
  | { status: "error"; error: unknown; retry: () => void }
  | {
      status: "ready";
      profile: {
        name?: string;
        onboardingCompleted?: boolean;
        /** Absent until onboarding's first step creates the profile. */
        baseCurrency?: string;
      };
    };

/**
 * Unified auth guard hook for protected pages.
 *
 * Handles:
 * - Redirecting unauthenticated users to login (Better Auth session cookie)
 * - Loading user profile (`profile.get`)
 * - Redirecting to/from onboarding based on profile state
 *
 * Returns a discriminated union so consumers can pattern-match on `status`.
 */
export function useAuthGuard(options: AuthGuardOptions = {}): AuthGuardResult {
  const {
    unauthenticatedRedirect = "/login",
    requireOnboarding = false,
    redirectIfOnboarded = false,
  } = options;

  const router = useRouter();
  const session = useSession();
  const isAuthenticated = session.data != null;

  const profileResult = useQuery({ ...profileQuery(), enabled: isAuthenticated });
  const profile = profileResult.data?.profile ?? null;
  const profileReady = isAuthenticated && profileResult.isSuccess;

  // Redirect to login if unauthenticated. `null` is a known signed-out state, even when a
  // later re-check failed (React Query keeps the data), so that case redirects too.
  const signedOut = session.data === null;
  useEffect(() => {
    if (signedOut) {
      router.navigate({ to: unauthenticatedRedirect });
    }
  }, [signedOut, router, unauthenticatedRedirect]);

  // Redirect to onboarding if not completed (dashboard, categories, etc.)
  useEffect(() => {
    if (requireOnboarding && profileReady && !profile?.onboardingCompleted) {
      router.navigate({ to: "/onboarding" });
    }
  }, [requireOnboarding, profileReady, profile, router]);

  // Redirect to dashboard if onboarding IS completed (onboarding page only)
  useEffect(() => {
    if (redirectIfOnboarded && profileReady && profile?.onboardingCompleted) {
      router.navigate({ to: "/dashboard" });
    }
  }, [redirectIfOnboarded, profileReady, profile, router]);

  // Only a first load that failed is an error: a failed background refetch keeps the
  // cached session and profile (React Query keeps `data`), so the shell stays mounted.
  if (session.isError && session.data === undefined) {
    return { status: "error", error: session.error, retry: () => void session.refetch() };
  }
  if (session.isPending) return { status: "loading" };

  // Not authenticated -- redirect in progress
  if (!isAuthenticated) return { status: "redirecting" };

  if (profileResult.isError && profileResult.data === undefined) {
    return { status: "error", error: profileResult.error, retry: () => void profileResult.refetch() };
  }
  if (profileResult.isPending) return { status: "loading" };

  // Onboarding required but not completed -- redirect in progress
  if (requireOnboarding && !profile?.onboardingCompleted) return { status: "redirecting" };

  // On onboarding page but already completed -- redirect in progress
  if (redirectIfOnboarded && profile?.onboardingCompleted) return { status: "redirecting" };

  return {
    status: "ready",
    profile: {
      name: profile?.name ?? session.data?.name,
      onboardingCompleted: profile?.onboardingCompleted ?? false,
      baseCurrency: profile?.baseCurrency,
    },
  };
}
