/**
 * Errors on `/api/trpc`. Procedures throw `DomainError` as on `/api/v1`; the
 * `mapErrors` middleware turns it (and the database errors the v1 router maps)
 * into a `TRPCError` with the matching HTTP status and the `DomainError` as
 * `cause`. The error formatter then puts the v1 error code and details on
 * `error.data` (`apiCode`, `details`), so clients keep branching on
 * `not_found`, `conflict`, `validation_failed`, ...
 */
import { TRPCError } from "@trpc/server";

import { sqlState } from "../db/tx";
import { DomainError } from "../domain/errors";
import { MoneyRangeError } from "../domain/money";

export type ApiErrorCode = DomainError["code"];
type TrpcCode = TRPCError["code"];

const TRPC_CODE: Record<ApiErrorCode, TrpcCode> = {
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  validation_failed: "BAD_REQUEST",
  conflict: "CONFLICT",
  rate_limited: "TOO_MANY_REQUESTS",
  internal: "INTERNAL_SERVER_ERROR",
};

/** For errors tRPC raises itself (unknown procedure, bad JSON, body too large). */
const API_CODE: Partial<Record<TrpcCode, ApiErrorCode>> = {
  PARSE_ERROR: "validation_failed",
  BAD_REQUEST: "validation_failed",
  PAYLOAD_TOO_LARGE: "validation_failed",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  METHOD_NOT_SUPPORTED: "not_found",
  CONFLICT: "conflict",
  TOO_MANY_REQUESTS: "rate_limited",
};

const UNSTORABLE_TEXT = new Set(["22021", "22P05"]);
const DATE_OUT_OF_RANGE = "22008";

export function trpcError(error: DomainError): TRPCError {
  return new TRPCError({ code: TRPC_CODE[error.code], message: error.message, cause: error });
}

export const fail = (code: ApiErrorCode, message: string, details?: unknown) => trpcError(new DomainError(code, message, details));

/** `{ issues: [{ path, message }] }`, the v1 `validation_failed` details. Works for Zod and Standard Schema issues. */
function validationIssues(issues: ReadonlyArray<{ path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>; message: string }>) {
  return {
    issues: issues.map((issue) => ({
      path: (issue.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)).join("."),
      message: issue.message,
    })),
  };
}

/** The `DomainError` a failure stands for, or null when it is an unexpected one (a 500 with no detail). */
export function domainErrorOf(error: TRPCError): DomainError | null {
  const cause = error.cause;
  if (cause instanceof DomainError) return cause;
  // Input validation: tRPC wraps the schema's error in a BAD_REQUEST.
  if (error.code === "BAD_REQUEST" && Array.isArray((cause as { issues?: unknown } | undefined)?.issues)) {
    return new DomainError("validation_failed", "Request validation failed", validationIssues((cause as unknown as { issues: never }).issues));
  }
  const state = sqlState(cause);
  if (state !== undefined && UNSTORABLE_TEXT.has(state)) {
    return new DomainError("validation_failed", "Text contains characters that can't be stored");
  }
  if (state === DATE_OUT_OF_RANGE) return new DomainError("validation_failed", "Date out of range");
  if (cause instanceof MoneyRangeError) return new DomainError("conflict", "Amount out of range");
  return null;
}

export interface ApiErrorData {
  code: TrpcCode;
  httpStatus: number;
  path?: string;
  /** The `/api/v1` error code. */
  apiCode: ApiErrorCode;
  /** `validation_failed`: `{ issues: [{ path, message }] }`; some conflicts carry a `reason`. */
  details?: unknown;
}

/** The error formatter: v1 code and details, no stack, and no message for unexpected errors. */
export function formatError(error: TRPCError, data: { httpStatus: number; path?: string }): { message: string; data: ApiErrorData } {
  const domain = error.cause instanceof DomainError ? error.cause : null;
  const apiCode = domain?.code ?? API_CODE[error.code] ?? "internal";
  const message = domain?.message ?? (apiCode === "internal" ? "Internal error" : error.message);
  return {
    message,
    data: {
      code: error.code,
      httpStatus: data.httpStatus,
      ...(data.path === undefined ? {} : { path: data.path }),
      apiCode,
      ...(domain?.details === undefined ? {} : { details: domain.details }),
    },
  };
}
