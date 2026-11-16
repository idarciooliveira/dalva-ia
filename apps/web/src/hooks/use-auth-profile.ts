import { createContext, useContext } from "react";
import type { AuthGuardResult } from "@/hooks/use-auth-guard";

/** Profile of an authenticated, onboarded user. */
export type ProtectedPageProfile = Extract<
  AuthGuardResult,
  { status: "ready" }
>["profile"];

/**
 * Context for sharing the authenticated user's profile from the layout route
 * to child routes. This avoids each child needing to re-run the auth guard.
 */
export const AuthProfileContext = createContext<ProtectedPageProfile | null>(
  null,
);

/**
 * Returns the authenticated user profile from the nearest layout route.
 * Must be called from a component rendered inside the `_authenticated` layout.
 *
 * @throws if used outside of the `_authenticated` layout.
 */
export function useAuthProfile(): ProtectedPageProfile {
  const profile = useContext(AuthProfileContext);
  if (!profile) {
    throw new Error(
      "useAuthProfile() must be used inside the _authenticated layout route.",
    );
  }
  return profile;
}
