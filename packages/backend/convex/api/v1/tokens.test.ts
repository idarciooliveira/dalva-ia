import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_SECRET } from "./test.helpers";
import { mintUserToken, TOKEN_SECRET_ENV, verifyUserToken } from "./tokens";

const b64url = (value: unknown) =>
  btoa(typeof value === "string" ? value : JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(header: unknown, payload: unknown, secret = TEST_SECRET) {
  const input = `${b64url(header)}.${b64url(payload)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(String.fromCharCode(...sig))}`;
}

const now = Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({
  sub: "user-1",
  scope: "finance:read",
  aud: "finance-api",
  iat: now,
  exp: now + 600,
  ...extra,
});

describe("api/v1 tokens", () => {
  beforeEach(() => vi.stubEnv(TOKEN_SECRET_ENV, TEST_SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("mints and verifies an HS256 token", async () => {
    const token = await mintUserToken("user-1", ["finance:read", "finance:write"], 600);
    const [header, payload] = token.split(".").slice(0, 2).map((s) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({ sub: "user-1", scope: "finance:read finance:write", aud: "finance-api" });
    expect(payload.exp - payload.iat).toBe(600);

    const result = await verifyUserToken(token);
    expect(result).toMatchObject({ ok: true, claims: { sub: "user-1", scopes: ["finance:read", "finance:write"] } });
  });

  it("accepts a hand-signed token and ignores unknown scopes", async () => {
    const result = await verifyUserToken(await sign({ alg: "HS256" }, claims({ scope: "admin finance:write" })));
    expect(result).toMatchObject({ ok: true, claims: { scopes: ["finance:write"] } });
  });

  it("rejects a wrong signature, a different secret and tampered payloads", async () => {
    const token = await mintUserToken("user-1", ["finance:read"], 600);
    const [h, p, s] = token.split(".") as [string, string, string];
    expect(await verifyUserToken(`${h}.${p}.${s.slice(0, -2)}AA`)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await verifyUserToken(`${h}.${b64url(claims({ sub: "user-2" }))}.${s}`)).toMatchObject({ ok: false });
    expect(await verifyUserToken(await sign({ alg: "HS256" }, claims(), "another-secret-0123456789abcdefghijkl"))).toMatchObject({ ok: false });
  });

  it("rejects alg confusion: none, HS512, RS256, missing alg, crit", async () => {
    const payload = claims();
    expect(await verifyUserToken(`${b64url({ alg: "none" })}.${b64url(payload)}.`)).toMatchObject({ ok: false });
    expect(await verifyUserToken(`${b64url({ alg: "none" })}.${b64url(payload)}`)).toMatchObject({ ok: false });
    for (const header of [{ alg: "HS512" }, { alg: "RS256" }, { typ: "JWT" }, { alg: "HS256", crit: ["exp"] }, { alg: "HS256", typ: "JOSE+JSON" }]) {
      expect(await verifyUserToken(await sign(header, payload))).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("checks exp, aud, sub, scope, iat and nbf", async () => {
    expect(await verifyUserToken(await sign({ alg: "HS256" }, claims({ exp: now - 1 })))).toMatchObject({ ok: false, reason: "expired" });
    expect(await verifyUserToken(await sign({ alg: "HS256" }, claims({ exp: now })), { now })).toMatchObject({ ok: false, reason: "expired" });
    const bad = [
      claims({ exp: undefined }),
      claims({ exp: "9999999999" }),
      claims({ aud: "other" }),
      claims({ aud: ["finance-api"] }),
      claims({ aud: undefined }),
      claims({ sub: "" }),
      claims({ sub: 42 }),
      claims({ scope: ["finance:read"] }),
      claims({ iat: now + 3600 }),
      claims({ nbf: now + 3600 }),
    ];
    for (const payload of bad) {
      expect(await verifyUserToken(await sign({ alg: "HS256" }, payload))).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("rejects malformed tokens", async () => {
    for (const token of ["", "a.b", "a.b.c.d", "!!.??.**", `${b64url({ alg: "HS256" })}.not-json.sig`, "x".repeat(5000)]) {
      expect(await verifyUserToken(token)).toMatchObject({ ok: false });
    }
  });

  it("reports a missing or short secret as misconfigured, and mint refuses it", async () => {
    const token = await mintUserToken("user-1", ["finance:read"], 600);
    vi.stubEnv(TOKEN_SECRET_ENV, "short");
    expect(await verifyUserToken(token)).toEqual({ ok: false, reason: "misconfigured" });
    await expect(mintUserToken("user-1", ["finance:read"], 600)).rejects.toThrow(/FINANCE_API_TOKEN_SECRET/);
    vi.stubEnv(TOKEN_SECRET_ENV, "");
    expect(await verifyUserToken(token)).toEqual({ ok: false, reason: "misconfigured" });
  });

  it("validates mint arguments", async () => {
    await expect(mintUserToken("", ["finance:read"], 600)).rejects.toThrow();
    await expect(mintUserToken("u", [], 600)).rejects.toThrow();
    await expect(mintUserToken("u", ["finance:admin" as never], 600)).rejects.toThrow();
    await expect(mintUserToken("u", ["finance:read"], 0)).rejects.toThrow();
    await expect(mintUserToken("u", ["finance:read"], 1.5)).rejects.toThrow();
    await expect(mintUserToken("u", ["finance:read"], 400 * 24 * 3600)).rejects.toThrow();
  });
});
