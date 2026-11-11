import { describe, expect, it } from "vitest";

import { generateLinkCode, hashLinkCode, timingSafeEqual } from "./linkCodes";

describe("link codes", () => {
  it("generates 43-char base64url codes from 32 random bytes", () => {
    const codes = new Set(Array.from({ length: 200 }, generateLinkCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes to stable hex sha256", async () => {
    expect(await hashLinkCode("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("timingSafeEqual compares any lengths", async () => {
    expect(await timingSafeEqual("same-key", "same-key")).toBe(true);
    expect(await timingSafeEqual("same-key", "same-kez")).toBe(false);
    expect(await timingSafeEqual("short", "a much longer key")).toBe(false);
    expect(await timingSafeEqual("", "")).toBe(true);
  });
});
