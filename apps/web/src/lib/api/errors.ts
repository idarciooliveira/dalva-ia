import { FinanceApiError, type FinanceApiErrorCode } from "@mpf/finance-contract";
import { TRPCClientError } from "@trpc/client";

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const OFFLINE_ERROR = "Can't reach DALVA right now. Check your connection and try again.";

/** A failed API call, from the `/api/v1` client or the tRPC client, in the v1 error vocabulary. */
interface ApiFailure {
  code: FinanceApiErrorCode;
  message: string;
  details?: unknown;
  /** HTTP status, or null when no response came back. */
  status: number | null;
}

function failureOf(error: unknown): ApiFailure | null {
  if (error instanceof FinanceApiError) {
    return { code: error.code, message: error.message, details: error.details, status: error.status };
  }
  if (!(error instanceof TRPCClientError)) return null;
  const data = error.data as { apiCode?: FinanceApiErrorCode; details?: unknown; httpStatus?: number } | undefined;
  if (data?.apiCode) return { code: data.apiCode, message: error.message, details: data.details, status: data.httpStatus ?? null };
  // No tRPC error body: no answer at all, an abort, or something in front of the API (the proxy) answered.
  const cause: unknown = error.cause;
  if (cause instanceof Error && cause.name === "AbortError") return { code: "aborted", message: error.message, status: null };
  const response = error.meta?.response as Response | undefined;
  if (!response) return { code: "network_error", message: error.message, status: null };
  return { code: "invalid_response", message: error.message, status: response.status };
}

function firstIssue(details: unknown): string | undefined {
  const issues = (details as { issues?: Array<{ message?: unknown }> } | undefined)?.issues;
  const message = Array.isArray(issues) ? issues[0]?.message : undefined;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/** A message for the user. Server messages are shown only for codes that carry user-facing text. */
export function apiErrorMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  // The session check: no answer, or the proxy without the API behind it.
  if (error instanceof TypeError) return OFFLINE_ERROR;
  if (isSessionError(error)) return error.status >= 500 ? OFFLINE_ERROR : fallback;
  const failure = failureOf(error);
  if (!failure) return fallback;
  switch (failure.code) {
    case "network_error":
    case "timeout":
      return OFFLINE_ERROR;
    case "unauthorized":
      return "Your session has expired. Please log in again.";
    case "rate_limited":
      return "Too many requests. Please wait a moment and try again.";
    case "validation_failed":
      return firstIssue(failure.details) ?? (failure.message || fallback);
    case "conflict":
    case "not_found":
      return failure.message || fallback;
    default:
      // No envelope from a 5xx: the proxy without the API behind it (Vite answers 500, others 502/504).
      return failure.code === "invalid_response" && failure.status !== null && failure.status >= 500 ? OFFLINE_ERROR : fallback;
  }
}

/** `SessionError` from auth-client, matched by name so this module doesn't load Better Auth. */
function isSessionError(error: unknown): error is Error & { status: number } {
  return error instanceof Error && error.name === "SessionError";
}

export function isApiError(error: unknown, code: FinanceApiErrorCode): boolean {
  return failureOf(error)?.code === code;
}

/** Worth retrying: no answer, or the server (or the proxy in front) failed. Never a 4xx. */
export function isTransientError(error: unknown): boolean {
  // The session check: better-fetch throws a TypeError when there is no answer.
  if (error instanceof TypeError) return true;
  if (isSessionError(error)) return error.status >= 500;
  const failure = failureOf(error);
  if (!failure) return false;
  if (failure.code === "network_error" || failure.code === "timeout" || failure.code === "internal") return true;
  return failure.code === "invalid_response" && failure.status !== null && failure.status >= 500;
}
