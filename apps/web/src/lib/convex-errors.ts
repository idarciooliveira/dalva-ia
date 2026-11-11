import { ConvexError } from "convex/values";

/**
 * The `message` of a `ConvexError` thrown with `{ code, message }`, or null for
 * anything else (network failures, unexpected server errors). Convex hides the
 * text of plain `Error`s from clients, so only coded errors can be shown as-is.
 */
export function convexErrorMessage(error: unknown, code: string): string | null {
  if (!(error instanceof ConvexError)) return null;
  let data: unknown = error.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const { code: actual, message } = (data ?? {}) as { code?: unknown; message?: unknown };
  return actual === code && typeof message === "string" ? message : null;
}

export const ACCOUNT_IN_USE = "ACCOUNT_IN_USE";
export const TRANSACTION_MANAGED = "TRANSACTION_MANAGED";
