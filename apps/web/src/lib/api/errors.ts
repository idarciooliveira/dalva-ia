import { FinanceApiError } from "@mpf/finance-contract";

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const OFFLINE_ERROR = "Can't reach DALVA right now. Check your connection and try again.";

/**
 * Thrown for reads and writes of the pages still on Convex (transactions,
 * transfers, dashboard, goals, debts, settings) until PRs 10-11 move them.
 */
export class LegacyBackendError extends Error {
  override name = "LegacyBackendError";
  constructor() {
    super("This section is moving to the new backend and is unavailable for now.");
  }
}

function firstIssue(details: unknown): string | undefined {
  const issues = (details as { issues?: Array<{ message?: unknown }> } | undefined)?.issues;
  const message = Array.isArray(issues) ? issues[0]?.message : undefined;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/** A message for the user. Server messages are shown only for codes that carry user-facing text. */
export function apiErrorMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  if (error instanceof LegacyBackendError) return error.message;
  // The session check: no answer, or the proxy without the API behind it.
  if (error instanceof TypeError) return OFFLINE_ERROR;
  if (isSessionError(error)) return error.status >= 500 ? OFFLINE_ERROR : fallback;
  if (!(error instanceof FinanceApiError)) return fallback;
  switch (error.code) {
    case "network_error":
    case "timeout":
      return OFFLINE_ERROR;
    case "unauthorized":
      return "Your session has expired. Please log in again.";
    case "rate_limited":
      return "Too many requests. Please wait a moment and try again.";
    case "validation_failed":
      return firstIssue(error.details) ?? (error.message || fallback);
    case "conflict":
    case "not_found":
      return error.message || fallback;
    default:
      // A proxy without the API behind it answers 502/504 without an envelope.
      return error.status !== null && error.status >= 502 ? OFFLINE_ERROR : fallback;
  }
}

/** `SessionError` from auth-client, matched by name so this module doesn't load Better Auth. */
function isSessionError(error: unknown): error is Error & { status: number } {
  return error instanceof Error && error.name === "SessionError";
}

export function isApiError(error: unknown, code: FinanceApiError["code"]): boolean {
  return error instanceof FinanceApiError && error.code === code;
}

/** Worth retrying: no answer, or the server (or the proxy in front) failed. Never a 4xx. */
export function isTransientError(error: unknown): boolean {
  // The session check: better-fetch throws a TypeError when there is no answer.
  if (error instanceof TypeError) return true;
  if (isSessionError(error)) return error.status >= 500;
  if (!(error instanceof FinanceApiError)) return false;
  if (error.code === "network_error" || error.code === "timeout" || error.code === "internal") return true;
  return error.code === "invalid_response" && error.status !== null && error.status >= 500;
}
