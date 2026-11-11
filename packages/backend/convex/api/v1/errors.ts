import { errorCodeSchema, type ErrorCode } from "@mpf/finance-contract";
import { ConvexError, type Value } from "convex/values";

import {
  CHANNEL_ALREADY_LINKED,
  EXTERNAL_ALREADY_LINKED,
  IDENTITY_NOT_FOUND,
  INVALID_LINK_CODE,
  USER_ALREADY_LINKED,
} from "../../domain/channelLinks";

export interface ApiErrorData {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Errors that cross the Convex function boundary as `ConvexError` so the
 * httpAction can map them to the contract envelope. Throwing inside a write
 * mutation also rolls the whole transaction back (idempotency record included).
 */
export function apiError(code: ErrorCode, message: string, details?: unknown): ConvexError<Value> {
  const data: Record<string, Value> = { code, message };
  if (details !== undefined) data.details = details as Value;
  return new ConvexError(data);
}

export function validationError(path: string, message: string) {
  return apiError("validation_failed", message, { issues: [{ path, message }] });
}

export function notFound(what: string) {
  return apiError("not_found", `${what} not found`);
}

/**
 * Read our error payload from a `ConvexError` caught across `runQuery` /
 * `runMutation`. The class identity and the `data` encoding are not stable
 * across that boundary (the runtime may hand back `data` as a JSON string),
 * so match by name and accept both forms.
 */
export function readApiErrorData(error: unknown): ApiErrorData | null {
  if (!(error instanceof ConvexError) && (error as { name?: unknown } | null)?.name !== "ConvexError") return null;
  let data: unknown = (error as { data?: unknown }).data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null) return null;
  const { code, message, details } = data as Record<string, unknown>;
  const parsed = errorCodeSchema.safeParse(code);
  if (!parsed.success || typeof message !== "string") return null;
  return { code: parsed.data, message, ...(details === undefined ? {} : { details }) };
}

/**
 * Domain functions throw plain `Error`s. Every message the API can reach is
 * listed here with its contract code; anything else stays an internal error.
 */
const DOMAIN_ERRORS: Readonly<Record<string, ErrorCode>> = {
  "Account not found": "not_found",
  "Linked account not found": "not_found",
  "Category not found": "not_found",
  "Parent category not found": "not_found",
  "Subcategory not found": "not_found",
  "Transaction not found": "not_found",
  "Linked transfer transaction not found": "not_found",
  "Goal not found": "not_found",
  "Contribution not found": "not_found",
  "Debt not found": "not_found",
  "Debt payment not found": "not_found",
  "Transaction is not a transfer": "not_found",
  "Adjustments cannot have a category": "validation_failed",
  "Adjustments cannot have a subcategory": "validation_failed",
  "Amount must be positive": "validation_failed",
  "Cannot transfer to the same account": "validation_failed",
  "Source account is required for account-linked goal contributions": "validation_failed",
  "Principal and interest cannot be negative": "validation_failed",
  "Principal and interest must add up to the payment amount": "validation_failed",
  "Principal amount cannot exceed the remaining balance": "validation_failed",
  "Invalid cursor": "validation_failed",
  [INVALID_LINK_CODE]: "not_found",
  [IDENTITY_NOT_FOUND]: "not_found",
  [EXTERNAL_ALREADY_LINKED]: "conflict",
  [USER_ALREADY_LINKED]: "conflict",
  [CHANNEL_ALREADY_LINKED]: "conflict",
};

export async function mapDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && !(error instanceof ConvexError)) {
      const code = DOMAIN_ERRORS[error.message];
      if (code) throw apiError(code, error.message);
    }
    throw error;
  }
}
