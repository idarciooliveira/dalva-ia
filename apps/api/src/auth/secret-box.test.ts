import { describe, expect, it } from "vitest";

import { createSecretBox, deriveSecretBoxKey } from "./secret-box";
import { deriveTokenSecret } from "./tokens";

const box = createSecretBox("a".repeat(32));

describe("secret box", () => {
  it("round-trips and never stores the plaintext", () => {
    const sealed = box.seal("123456:secret-token-value", "telegram_bot_token");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("secret-token-value");
    expect(box.open(sealed, "telegram_bot_token")).toBe("123456:secret-token-value");
  });

  it("uses a fresh IV per seal", () => {
    expect(box.seal("same", "x")).not.toBe(box.seal("same", "x"));
  });

  it("returns null under another auth secret (rotated BETTER_AUTH_SECRET)", () => {
    const sealed = box.seal("value", "ai_api_key");
    expect(createSecretBox("b".repeat(32)).open(sealed, "ai_api_key")).toBeNull();
  });

  it("binds the value to its label", () => {
    expect(box.open(box.seal("value", "ai_api_key"), "telegram_bot_token")).toBeNull();
  });

  it("returns null for tampered or malformed values", () => {
    const sealed = box.seal("value", "x");
    const [v, iv, ct, tag] = sealed.split(".");
    const flipped = ct!.startsWith("A") ? `B${ct!.slice(1)}` : `A${ct!.slice(1)}`;
    expect(box.open([v, iv, flipped, tag].join("."), "x")).toBeNull();
    for (const bad of ["", "v1", "v2.a.b.c", "v1.a.b", "v1.!!.b.c", `v1.${iv}.${ct}.AAAA`]) expect(box.open(bad, "x")).toBeNull();
  });

  it("derives a key of its own, not the token secret", () => {
    expect(deriveSecretBoxKey("a".repeat(32)).toString("hex")).not.toBe(deriveTokenSecret("a".repeat(32)));
  });
});
