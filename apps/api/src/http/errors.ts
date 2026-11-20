import { ERROR_STATUS, type ErrorCode, fail } from "@mpf/finance-contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The contract's error envelope with its status. Answers through the context,
 * so headers set earlier (a renewed session cookie) go out with it.
 */
export function errorResponse(c: Context, code: ErrorCode, message: string, details?: unknown): Response {
  if (code === "unauthorized") c.header("WWW-Authenticate", 'Bearer realm="finance-api"');
  return c.json(fail(code, message, details), ERROR_STATUS[code] as ContentfulStatusCode);
}
