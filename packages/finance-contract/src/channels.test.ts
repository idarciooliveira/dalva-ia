import { describe, expect, it } from "vitest";

import {
  channelIdentityResolveRequestSchema,
  channelIdentityResolveResponseSchema,
  channelIdentityUnlinkRequestSchema,
  channelLinkRedeemRequestSchema,
  channelLinkRedeemResponseSchema,
  linkCodeSchema,
} from "./schemas";

const code = "Ab3_-".repeat(8) + "xyz"; // 43 chars, base64url

describe("linkCodeSchema", () => {
  it("accepts Telegram start-param safe codes up to 64 chars", () => {
    expect(linkCodeSchema.safeParse(code).success).toBe(true);
    expect(linkCodeSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it("rejects short, long and unsafe codes", () => {
    for (const bad of ["short", "a".repeat(65), "has space in it here", "a+b/c=d".repeat(4), "é".repeat(20)]) {
      expect(linkCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("channelLinkRedeemRequestSchema", () => {
  const valid = { channel: "telegram", code, externalUserId: "123456789", chatId: "123456789" };

  it("accepts a redeem with and without username", () => {
    expect(channelLinkRedeemRequestSchema.parse(valid)).toEqual(valid);
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, username: "alice" }).success).toBe(true);
  });

  it("accepts negative chat ids (groups) as strings", () => {
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, chatId: "-1001234567890" }).success).toBe(true);
  });

  it("rejects unknown channels, numeric ids, bad codes and unknown keys", () => {
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, channel: "whatsapp" }).success).toBe(false);
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, externalUserId: 123 }).success).toBe(false);
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, code: "nope" }).success).toBe(false);
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, userId: "u1" }).success).toBe(false);
    expect(channelLinkRedeemRequestSchema.safeParse({ ...valid, externalUserId: "" }).success).toBe(false);
  });
});

describe("resolve and unlink", () => {
  it("resolve needs channel, externalUserId and chatId; never a userId", () => {
    const valid = { channel: "telegram", externalUserId: "1", chatId: "1" };
    expect(channelIdentityResolveRequestSchema.safeParse(valid).success).toBe(true);
    expect(channelIdentityResolveRequestSchema.safeParse({ channel: "telegram", externalUserId: "1" }).success).toBe(false);
    expect(channelIdentityResolveRequestSchema.safeParse({ ...valid, userId: "u" }).success).toBe(false);
  });

  it("unlink needs channel and externalUserId", () => {
    expect(channelIdentityUnlinkRequestSchema.safeParse({ channel: "telegram", externalUserId: "1" }).success).toBe(true);
    expect(channelIdentityUnlinkRequestSchema.safeParse({ channel: "telegram" }).success).toBe(false);
  });

  it("parses identity and resolve responses", () => {
    const identity = {
      id: "ci1",
      channel: "telegram",
      externalUserId: "1",
      chatId: "1",
      scopes: ["finance:read"],
      linkedAt: "2026-11-11T10:00:00.000Z",
      consentAt: "2026-11-11T09:59:00.000Z",
    };
    expect(channelLinkRedeemResponseSchema.safeParse({ identity }).success).toBe(true);
    const resolved = channelIdentityResolveResponseSchema.safeParse({
      token: "a.b.c",
      expiresAt: "2026-11-11T10:15:00.000Z",
      scopes: ["finance:read", "finance:write"],
      identity,
      profile: { displayName: "Alice", baseCurrency: "EUR" },
    });
    expect(resolved.success).toBe(true);
    expect(channelIdentityResolveResponseSchema.safeParse({ token: "t", expiresAt: "x", scopes: [], identity, profile: {} }).success).toBe(true);
  });
});
