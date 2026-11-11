import { timingSafeEqual } from "../../lib/linkCodes";
import { TOKEN_SECRET_ENV } from "./tokens";

/**
 * Service key for the service routes (the chat agent). Convex env var,
 * at least 32 bytes, and never the same value as the token secret.
 */
export const SERVICE_KEY_ENV = "FINANCE_API_SERVICE_KEY";
const MIN_SERVICE_KEY_BYTES = 32;

export type ServiceAuthResult = { ok: true } | { ok: false; reason: "invalid" | "misconfigured" };

function readServiceKey(): string | null {
  const key = process.env[SERVICE_KEY_ENV];
  if (!key || new TextEncoder().encode(key).length < MIN_SERVICE_KEY_BYTES) return null;
  if (key === process.env[TOKEN_SECRET_ENV]) return null;
  return key;
}

/** Compare a presented credential with the service key in constant time. */
export async function verifyServiceKey(presented: string): Promise<ServiceAuthResult> {
  const key = readServiceKey();
  if (!key) return { ok: false, reason: "misconfigured" };
  return (await timingSafeEqual(presented, key)) ? { ok: true } : { ok: false, reason: "invalid" };
}
