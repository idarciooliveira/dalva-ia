import { z } from "zod";

/** Mounted under this path by the server (`/api/v1/...`). */
export const API_BASE_PATH = "/api/v1";

export const AUTHORIZATION_HEADER = "Authorization";
/** Required on every write (POST/PATCH/DELETE). Replays with the same key return the original result. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, "Idempotency key must be 8-128 chars of [A-Za-z0-9._:-]");

export function bearerAuthorization(token: string): string {
  return `Bearer ${token}`;
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function parseBearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

export const errorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "rate_limited",
  "internal",
]);
export type ErrorCode = z.output<typeof errorCodeSchema>;

/** HTTP status the server uses for each error code. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409, // also: Idempotency-Key reused with a different request
  rate_limited: 429,
  internal: 500,
};

export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    /** `validation_failed` carries `{ issues: [{ path, message }] }`. */
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/*  Envelope                                                                  */
/* -------------------------------------------------------------------------- */

export const successEnvelope = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data });

export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export function fail(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Standard `details` payload for `validation_failed`. */
export function validationIssues(error: z.ZodError) {
  return {
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}
