/**
 * The chat agent's service key (`FINANCE_API_SERVICE_KEY`): a shared secret
 * sent as `Authorization: Bearer`, accepted on the service routes only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_SERVICE_KEY_BYTES = 32;

const digest = (value: string) => createHash("sha256").update(value).digest();

export interface ServiceKey {
  /** Constant time: both sides are hashed first, so neither content nor length leaks through timing. */
  matches(presented: string): boolean;
}

export function createServiceKey(key: string): ServiceKey {
  if (new TextEncoder().encode(key).length < MIN_SERVICE_KEY_BYTES) {
    throw new Error(`service key must be at least ${MIN_SERVICE_KEY_BYTES} bytes`);
  }
  const expected = digest(key);
  return { matches: (presented) => timingSafeEqual(digest(presented), expected) };
}
