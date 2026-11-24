/** The API's error codes, on `error.data.apiCode`. */
export type ErrorCode = "unauthorized" | "forbidden" | "not_found" | "validation_failed" | "conflict" | "rate_limited" | "internal";

/**
 * An expected failure, with the error code the API answers with.
 * Domain and procedure code throw it; `src/trpc/errors.ts` turns it into the
 * error response (and the write's transaction, idempotency record included,
 * rolls back).
 * Anything else that escapes a handler is a 500 whose message is never sent.
 */
export class DomainError extends Error {
  override name = "DomainError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** `"Account"` -> 404 "Account not found". Missing and someone else's rows look the same. */
export function notFound(what: string): DomainError {
  return new DomainError("not_found", `${what} not found`);
}

export function conflict(message: string, details?: unknown): DomainError {
  return new DomainError("conflict", message, details);
}

/** `validation_failed` with the `{ issues: [{ path, message }] }` details. */
export function invalid(path: string, message: string): DomainError {
  return new DomainError("validation_failed", message, { issues: [{ path, message }] });
}
