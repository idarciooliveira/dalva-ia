/**
 * User tokens for the Finance API: compact JWS, HS256, Web Crypto only (runs
 * in the default Convex runtime, no Node APIs).
 *
 * Claims: `sub` (userId), `scope` (space-separated), `aud` ("finance-api"),
 * `iat`, `exp`, and `cid` (channel identity id) for tokens minted by
 * `channelIdentities.resolve`: those are re-checked against the identity on
 * every request, so unlinking or switching to read-only applies at once.
 * Secret: Convex env var `FINANCE_API_TOKEN_SECRET` (>= 32 bytes).
 */

export const FINANCE_API_AUDIENCE = "finance-api";
export const FINANCE_SCOPES = ["finance:read", "finance:write"] as const;
export type FinanceScope = (typeof FINANCE_SCOPES)[number];

export const TOKEN_SECRET_ENV = "FINANCE_API_TOKEN_SECRET";
const MIN_SECRET_BYTES = 32;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Tolerated clock skew for `iat` / `nbf`. `exp` gets none. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;

export interface UserTokenClaims {
  sub: string;
  scopes: FinanceScope[];
  exp: number;
  iat?: number;
  /** Channel identity the token was minted for. */
  cid?: string;
}

export type VerifyResult =
  | { ok: true; claims: UserTokenClaims }
  | { ok: false; reason: "invalid" | "expired" | "misconfigured" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!SEGMENT_RE.test(segment) || segment.length % 4 === 1) return null;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readSecret(): string | null {
  const secret = process.env[TOKEN_SECRET_ENV];
  if (!secret || encoder.encode(secret).length < MIN_SECRET_BYTES) return null;
  return secret;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Issue a user token. Server-side only: call it from Convex functions (PR 4
 * uses it after channel linking). Throws if the secret is missing or short.
 */
export async function mintUserToken(
  userId: string,
  scopes: readonly FinanceScope[],
  ttlSeconds: number,
  options: { now?: number; channelIdentityId?: string } = {},
): Promise<string> {
  if (typeof userId !== "string" || userId.length === 0) throw new Error("mintUserToken: userId is required");
  if (scopes.length === 0 || scopes.some((s) => !FINANCE_SCOPES.includes(s))) {
    throw new Error("mintUserToken: scopes must be a non-empty subset of finance:read, finance:write");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error("mintUserToken: ttlSeconds must be a positive integer up to one year");
  }
  const secret = readSecret();
  if (!secret) throw new Error(`mintUserToken: ${TOKEN_SECRET_ENV} is missing or shorter than ${MIN_SECRET_BYTES} bytes`);

  const iat = options.now ?? nowSeconds();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        sub: userId,
        scope: [...new Set(scopes)].join(" "),
        aud: FINANCE_API_AUDIENCE,
        iat,
        exp: iat + ttlSeconds,
        ...(options.channelIdentityId ? { cid: options.channelIdentityId } : {}),
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a user token. Only HS256 is accepted (no `none`, no algorithm
 * negotiation); the signature is checked with `crypto.subtle.verify`, which
 * compares in constant time, before any claim is trusted.
 */
export async function verifyUserToken(token: string, options: { now?: number } = {}): Promise<VerifyResult> {
  const secret = readSecret();
  if (!secret) return { ok: false, reason: "misconfigured" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeJsonSegment(headerSegment);
  if (!header || header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT") || "crit" in header) {
    return { ok: false, reason: "invalid" };
  }

  const signature = base64UrlDecode(signatureSegment);
  if (!signature || !SEGMENT_RE.test(payloadSegment)) return { ok: false, reason: "invalid" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!valid) return { ok: false, reason: "invalid" };

  const payload = decodeJsonSegment(payloadSegment);
  if (!payload) return { ok: false, reason: "invalid" };
  const { sub, scope, aud, exp, iat, nbf, cid } = payload;
  const now = options.now ?? nowSeconds();

  if (typeof sub !== "string" || sub.length === 0 || sub.length > 256) return { ok: false, reason: "invalid" };
  if (aud !== FINANCE_API_AUDIENCE) return { ok: false, reason: "invalid" };
  if (typeof scope !== "string") return { ok: false, reason: "invalid" };
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, reason: "invalid" };
  if (iat !== undefined && (typeof iat !== "number" || iat > now + CLOCK_SKEW_SECONDS)) {
    return { ok: false, reason: "invalid" };
  }
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > now + CLOCK_SKEW_SECONDS)) {
    return { ok: false, reason: "invalid" };
  }
  if (cid !== undefined && (typeof cid !== "string" || cid.length === 0 || cid.length > 256)) {
    return { ok: false, reason: "invalid" };
  }
  if (now >= exp) return { ok: false, reason: "expired" };

  const scopes = FINANCE_SCOPES.filter((s) => scope.split(" ").includes(s));
  return {
    ok: true,
    claims: { sub, scopes, exp, ...(typeof iat === "number" ? { iat } : {}), ...(cid !== undefined ? { cid } : {}) },
  };
}
