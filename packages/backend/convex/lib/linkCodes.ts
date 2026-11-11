/**
 * Link codes and service-key checks. Web Crypto only; call from actions or
 * httpActions (mutations stay free of crypto so they remain deterministic).
 */

/** 32 random bytes -> 43 chars of base64url: Telegram `start`-param safe (`[A-Za-z0-9_-]`, <= 64). */
export const LINK_CODE_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateLinkCode(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(LINK_CODE_BYTES)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Codes carry 256 bits of entropy, so a plain SHA-256 is enough (no salt or
 * slow hash needed). Lookups go by hash, so the raw code is never stored or compared.
 */
export async function hashLinkCode(code: string): Promise<string> {
  return [...(await sha256(code))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison: both sides are hashed to 32 bytes first,
 * so neither content nor length leaks through timing.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
