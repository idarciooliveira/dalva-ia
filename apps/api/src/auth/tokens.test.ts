import { describe, expect, it } from "vitest";

import { TEST_TOKEN_SECRET } from "../../test/app";
import { createUserTokens } from "./tokens";

const tokens = createUserTokens(TEST_TOKEN_SECRET);

const b64url = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

async function sign(header: unknown, payload: unknown, secret = TEST_TOKEN_SECRET) {
  const input = `${b64url(header)}.${b64url(payload)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return `${input}.${Buffer.from(sig).toString("base64url")}`;
}

const decodeSegment = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

const now = Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({
  sub: "user-1",
  scope: "finance:read",
  aud: "finance-api",
  iat: now,
  exp: now + 600,
  ...extra,
});

/** Minted by the Convex backend (`convex/api/v1/tokens.ts`) with TEST_TOKEN_SECRET and `now: 4_000_000_000`. */
const CONVEX_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMTkwYTFiMi1jM2Q0LTdlNWYtOGE5Yi0wYzFkMmUzZjRhNWIiLCJzY29wZSI6ImZpbmFuY2U6cmVhZCBmaW5hbmNlOndyaXRlIGFnZW50OnN0YXRlIiwiYXVkIjoiZmluYW5jZS1hcGkiLCJpYXQiOjQwMDAwMDAwMDAsImV4cCI6NDAzMTUzNTk5OSwiY2lkIjoiMDE5MGExYjItYzNkNC03ZTVmLThhOWItMGMxZDJlM2Y0YTVjIn0.IA5iRKIXZS_WVuPSAKq9VkcB1QU_QH5BACSJ0g-oMF0";

describe("user tokens", () => {
  it("mints and verifies an HS256 token", async () => {
    const token = await tokens.mint("user-1", ["finance:read", "finance:write"], 600);
    const [header, payload] = token.split(".").slice(0, 2).map(decodeSegment);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({ sub: "user-1", scope: "finance:read finance:write", aud: "finance-api" });
    expect(payload.exp - payload.iat).toBe(600);

    expect(await tokens.verify(token)).toMatchObject({ ok: true, claims: { sub: "user-1", scopes: ["finance:read", "finance:write"] } });
  });

  it("is byte-compatible with tokens the Convex backend mints", async () => {
    const options = { channelIdentityId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", now: 4_000_000_000 };
    const minted = await tokens.mint("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", ["finance:read", "finance:write", "agent:state"], 365 * 24 * 3600 - 1, options);
    expect(minted).toBe(CONVEX_TOKEN);
    expect(await tokens.verify(CONVEX_TOKEN, { now: 4_000_000_100 })).toEqual({
      ok: true,
      claims: {
        sub: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        scopes: ["finance:read", "finance:write", "agent:state"],
        iat: 4_000_000_000,
        exp: 4_031_535_999,
        cid: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
      },
    });
  });

  it("accepts a hand-signed token and ignores unknown scopes", async () => {
    const result = await tokens.verify(await sign({ alg: "HS256" }, claims({ scope: "admin finance:write" })));
    expect(result).toMatchObject({ ok: true, claims: { scopes: ["finance:write"] } });
  });

  it("carries the agent:state scope next to the finance ones", async () => {
    const token = await tokens.mint("user-1", ["finance:read", "agent:state"], 600);
    expect(decodeSegment(token.split(".")[1]!)).toMatchObject({ scope: "finance:read agent:state" });
    expect(await tokens.verify(token)).toMatchObject({ ok: true, claims: { scopes: ["finance:read", "agent:state"] } });
    expect(await tokens.verify(await sign({ alg: "HS256" }, claims({ scope: "agent:state" })))).toMatchObject({
      ok: true,
      claims: { scopes: ["agent:state"] },
    });
    await expect(tokens.mint("user-1", ["agent:state", "agent:admin" as never], 600)).rejects.toThrow("scopes");
  });

  it("rejects a wrong signature, a different secret and tampered payloads", async () => {
    const token = await tokens.mint("user-1", ["finance:read"], 600);
    const [h, p, s] = token.split(".") as [string, string, string];
    expect(await tokens.verify(`${h}.${p}.${s.slice(0, -2)}AA`)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await tokens.verify(`${h}.${b64url(claims({ sub: "user-2" }))}.${s}`)).toMatchObject({ ok: false });
    expect(await tokens.verify(await sign({ alg: "HS256" }, claims(), "another-secret-0123456789abcdefghijkl"))).toMatchObject({ ok: false });
  });

  it("rejects alg confusion: none, HS512, RS256, missing alg, crit", async () => {
    const payload = claims();
    expect(await tokens.verify(`${b64url({ alg: "none" })}.${b64url(payload)}.`)).toMatchObject({ ok: false });
    expect(await tokens.verify(`${b64url({ alg: "none" })}.${b64url(payload)}`)).toMatchObject({ ok: false });
    for (const header of [{ alg: "HS512" }, { alg: "RS256" }, { typ: "JWT" }, { alg: "HS256", crit: ["exp"] }, { alg: "HS256", typ: "JOSE+JSON" }]) {
      expect(await tokens.verify(await sign(header, payload))).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("checks exp, aud, sub, scope, iat and nbf", async () => {
    expect(await tokens.verify(await sign({ alg: "HS256" }, claims({ exp: now - 1 })))).toMatchObject({ ok: false, reason: "expired" });
    expect(await tokens.verify(await sign({ alg: "HS256" }, claims({ exp: now })), { now })).toMatchObject({ ok: false, reason: "expired" });
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
      expect(await tokens.verify(await sign({ alg: "HS256" }, payload))).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("rejects malformed tokens", async () => {
    const malformed = ["", "a.b", "a.b.c.d", "!!.??.**", `${b64url({ alg: "HS256" })}.not-json.sig`, "x".repeat(5000), "a=.b.c"];
    for (const token of malformed) {
      expect(await tokens.verify(token)).toMatchObject({ ok: false });
    }
  });

  it("refuses a secret under 32 bytes", () => {
    expect(() => createUserTokens("short")).toThrow(/32 bytes/);
    expect(() => createUserTokens("")).toThrow(/32 bytes/);
  });

  it("validates mint arguments", async () => {
    await expect(tokens.mint("", ["finance:read"], 600)).rejects.toThrow();
    await expect(tokens.mint("u", [], 600)).rejects.toThrow();
    await expect(tokens.mint("u", ["finance:admin" as never], 600)).rejects.toThrow();
    await expect(tokens.mint("u", ["finance:read"], 0)).rejects.toThrow();
    await expect(tokens.mint("u", ["finance:read"], 1.5)).rejects.toThrow();
    await expect(tokens.mint("u", ["finance:read"], 400 * 24 * 3600)).rejects.toThrow();
  });

  it("carries the channel identity id as cid and rejects a malformed one", async () => {
    const token = await tokens.mint("user-1", ["finance:read"], 600, { channelIdentityId: "ci-1" });
    expect(await tokens.verify(token)).toMatchObject({ ok: true, claims: { sub: "user-1", cid: "ci-1" } });
    const plain = await tokens.verify(await tokens.mint("user-1", ["finance:read"], 600));
    expect(plain.ok && "cid" in plain.claims).toBe(false);
    for (const cid of [123, "", "x".repeat(300)]) {
      expect(await tokens.verify(await sign({ alg: "HS256" }, claims({ cid })))).toEqual({ ok: false, reason: "invalid" });
    }
  });
});
