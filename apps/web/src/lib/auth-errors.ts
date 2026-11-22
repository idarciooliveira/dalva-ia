import type { AuthFailure } from "@/lib/auth-client";

const FALLBACK_MESSAGES = {
  signIn: "Unable to sign in. Please check your credentials and try again.",
  signUp: "Unable to create account. Please try again.",
  default: "Something went wrong. Please try again.",
} as const;

/** Better Auth error codes (and the API's own sign-in limiter) → the copy the forms showed before. */
const MESSAGES: Record<string, string> = {
  USER_ALREADY_EXISTS: "An account with this email already exists. Try logging in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "An account with this email already exists. Try logging in instead.",
  INVALID_EMAIL_OR_PASSWORD: "Invalid email or password. Please try again.",
  INVALID_PASSWORD: "Invalid email or password. Please try again.",
  PASSWORD_TOO_SHORT: "Password must be at least 8 characters long.",
  INVALID_EMAIL: "Please enter a valid email address.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Please wait a moment and try again.",
  // The page's origin isn't the API's PUBLIC_URL (e.g. 127.0.0.1 instead of localhost).
  INVALID_ORIGIN: "Open DALVA at its usual address to sign in.",
};

/** A user-facing message for a failed Better Auth call (`{ error }` of the client, or a thrown error). */
export function authErrorMessage(
  error: AuthFailure | unknown,
  flow: "signIn" | "signUp" | "default" = "default",
): string {
  const failure = (typeof error === "object" && error !== null ? error : {}) as Partial<AuthFailure>;
  if (failure.code && MESSAGES[failure.code]) return MESSAGES[failure.code]!;
  if (failure.status === 429) return MESSAGES.TOO_MANY_ATTEMPTS!;
  if (typeof failure.status !== "number" || failure.status === 0 || failure.status >= 500) {
    // No answer, or the API is down behind the proxy.
    return "Can't reach DALVA right now. Check your connection and try again.";
  }
  return FALLBACK_MESSAGES[flow];
}
