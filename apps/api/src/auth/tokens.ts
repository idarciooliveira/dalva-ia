/**
 * User tokens for the Finance API: compact JWS, HS256, Web Crypto only. Same
 * format, claims and secret (`FINANCE_API_TOKEN_SECRET`) as the Convex
 * backend, so the chat agent works with either. User and identity ids differ
 * between the two (Convex ids vs UUIDs), so a token is only useful on the
 * backend that minted it; the agent resolves a fresh one for every message.
 *
 * Claims: `sub` (user id), `scope` (space-separated: finance:read,
 * finance:write, agent:state), `aud` ("finance-api"), `iat`, `exp`, and `cid`
 * (channel identity id) on tokens minted for a linked chat: those are checked
 * against the identity on every request, so unlinking or switching to
 * read-only applies at once.
 */
/**
 * Scope of the agent store (sessions, messages, pending actions, history).
 * `channelIdentities.resolve` always grants it, read-only identities included,
 * so the bot keeps its conversation state.
 */
export const AGENT_STATE_SCOPE = "agent:state" as const;
/** Every scope a user token can carry. */
export const TOKEN_SCOPES = ["finance:read", "finance:write", AGENT_STATE_SCOPE] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const FINANCE_API_AUDIENCE = "finance-api";
export const MIN_TOKEN_SECRET_BYTES = 32;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Tolerated clock skew for `iat` / `nbf`. `exp` gets none. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;

export interface UserTokenClaims {
  sub: string;
  scopes: TokenScope[];
  exp: number;
  iat?: number;
  /** Channel identity the token was minted for. */
  cid?: string;
}

export type VerifyResult = { ok: true; claims: UserTokenClaims } | { ok: false; reason: "invalid" | "expired" };

export interface MintOptions {
  /** Seconds since the epoch; default now. */
  now?: number;
  channelIdentityId?: string;
}

export interface UserTokens {
  mint(userId: string, scopes: readonly TokenScope[], ttlSeconds: number, options?: MintOptions): Promise<string>;
  verify(token: string, options?: { now?: number }): Promise<VerifyResult>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  // Node's decoder skips bad characters instead of failing: check the alphabet and length first.
  if (!SEGMENT_RE.test(segment) || segment.length % 4 === 1) return null;
  return new Uint8Array(Buffer.from(segment, "base64url"));
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const INVALID = { ok: false, reason: "invalid" } as const;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Mint and verify user tokens with `secret` (at least 32 bytes; config checks it at boot). */
export function createUserTokens(secret: string): UserTokens {
  if (encoder.encode(secret).length < MIN_TOKEN_SECRET_BYTES) {
    throw new Error(`token secret must be at least ${MIN_TOKEN_SECRET_BYTES} bytes`);
  }
  const key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

  return {
    async mint(userId, scopes, ttlSeconds, options = {}) {
      if (typeof userId !== "string" || userId.length === 0) throw new Error("mint: userId is required");
      if (scopes.length === 0 || scopes.some((s) => !TOKEN_SCOPES.includes(s))) {
        throw new Error(`mint: scopes must be a non-empty subset of ${TOKEN_SCOPES.join(", ")}`);
      }
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
        throw new Error("mint: ttlSeconds must be a positive integer up to one year");
      }
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
      const signature = await crypto.subtle.sign("HMAC", await key, encoder.encode(signingInput));
      return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
    },

    /**
     * Only HS256 is accepted (no `none`, no algorithm negotiation). The
     * signature is checked with `crypto.subtle.verify` (constant time) before
     * any claim is trusted.
     */
    async verify(token, options = {}) {
      if (token.length > MAX_TOKEN_LENGTH) return INVALID;
      const parts = token.split(".");
      if (parts.length !== 3) return INVALID;
      const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

      const header = decodeJsonSegment(headerSegment);
      if (!header || header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT") || "crit" in header) {
        return INVALID;
      }
      const signature = base64UrlDecode(signatureSegment);
      if (!signature || !SEGMENT_RE.test(payloadSegment)) return INVALID;
      const valid = await crypto.subtle.verify(
        "HMAC",
        await key,
        signature,
        encoder.encode(`${headerSegment}.${payloadSegment}`),
      );
      if (!valid) return INVALID;

      const payload = decodeJsonSegment(payloadSegment);
      if (!payload) return INVALID;
      const { sub, scope, aud, exp, iat, nbf, cid } = payload;
      const now = options.now ?? nowSeconds();

      if (typeof sub !== "string" || sub.length === 0 || sub.length > 256) return INVALID;
      if (aud !== FINANCE_API_AUDIENCE) return INVALID;
      if (typeof scope !== "string") return INVALID;
      if (typeof exp !== "number" || !Number.isFinite(exp)) return INVALID;
      if (iat !== undefined && (typeof iat !== "number" || iat > now + CLOCK_SKEW_SECONDS)) {
        return INVALID;
      }
      if (nbf !== undefined && (typeof nbf !== "number" || nbf > now + CLOCK_SKEW_SECONDS)) {
        return INVALID;
      }
      if (cid !== undefined && (typeof cid !== "string" || cid.length === 0 || cid.length > 256)) {
        return INVALID;
      }
      if (now >= exp) return { ok: false, reason: "expired" };

      const scopes = TOKEN_SCOPES.filter((s) => scope.split(" ").includes(s));
      return {
        ok: true,
        claims: { sub, scopes, exp, ...(typeof iat === "number" ? { iat } : {}), ...(cid !== undefined ? { cid } : {}) },
      };
    },
  };
}
