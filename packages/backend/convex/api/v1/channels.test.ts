import { FinanceApiError } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { INVALID_LINK_CODE } from "../../domain/channelLinks";
import { hashLinkCode } from "../../lib/linkCodes";
import { RESOLVED_TOKEN_TTL_SECONDS } from "./serviceRegistry";
import {
  clientFor,
  expectApiError,
  raw,
  seedAccount,
  seedUser,
  serviceClientFor,
  setupApi,
  TEST_SERVICE_KEY,
  type T,
} from "./test.helpers";
import { verifyUserToken } from "./tokens";

const TG = "telegram" as const;
const chat = (id: string, extra: { chatId?: string; username?: string } = {}) => ({
  channel: TG,
  externalUserId: id,
  chatId: extra.chatId ?? id,
  ...(extra.username ? { username: extra.username } : {}),
});

const identityId = (id: string) => id as Id<"channelIdentities">;
const asWebUser = (t: T, userId: string) => t.withIdentity({ subject: `${userId}|session-${userId}` });

async function createCode(t: T, userId: string) {
  return await asWebUser(t, userId).action(api.channelLinks.createLinkCode, { channel: TG, consent: true });
}

async function linkedUser(t: T, externalUserId = "1001", options: { name?: string; currency?: string } = {}) {
  const userId = await seedUser(t, { baseCurrency: options.currency ?? "USD" });
  if (options.name) await t.run((ctx) => ctx.db.patch(userId as Id<"users">, { name: options.name }));
  const { code } = await createCode(t, userId);
  const service = serviceClientFor(t);
  const { identity } = await service.channelLinks.redeem({ ...chat(externalUserId, { username: "alice" }), code });
  return { userId, identity, service };
}

describe("channelLinks.redeem", () => {
  it("creates the identity for the code's owner with read+write scopes and stores only the hash", async () => {
    const t = setupApi();
    const userId = await seedUser(t);
    const { code, expiresAt } = await createCode(t, userId);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(9 * 60 * 1000);

    const rows = await t.run((ctx) => ctx.db.query("channelLinkCodes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBe(await hashLinkCode(code));
    expect(JSON.stringify(rows)).not.toContain(code);

    const { identity } = await serviceClientFor(t).channelLinks.redeem({ ...chat("1001", { username: "alice" }), code });
    expect(identity).toMatchObject({
      channel: "telegram",
      externalUserId: "1001",
      chatId: "1001",
      username: "alice",
      scopes: ["finance:read", "finance:write"],
    });
    const stored = await t.run((ctx) => ctx.db.query("channelIdentities").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0]!.userId).toBe(userId);
    expect(stored[0]!.consentAt).toBeLessThanOrEqual(stored[0]!.linkedAt);
  });

  it("is single-use", async () => {
    const t = setupApi();
    const userId = await seedUser(t);
    const { code } = await createCode(t, userId);
    const service = serviceClientFor(t);
    await service.channelLinks.redeem({ ...chat("1001"), code });
    await t.run(async (ctx) => {
      const identity = (await ctx.db.query("channelIdentities").first())!;
      await ctx.db.patch(identity._id, { unlinkedAt: Date.now() }); // even after unlinking
    });
    const again = await expectApiError(service.channelLinks.redeem({ ...chat("1001"), code }), "not_found", 404);
    expect(again.message).toBe(INVALID_LINK_CODE);
    const other = await expectApiError(service.channelLinks.redeem({ ...chat("2002"), code }), "not_found", 404);
    expect(other.message).toBe(INVALID_LINK_CODE);
  });

  it("rejects an expired code", async () => {
    const t = setupApi();
    const userId = await seedUser(t);
    const { code } = await createCode(t, userId);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("channelLinkCodes").first())!;
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    const error = await expectApiError(serviceClientFor(t).channelLinks.redeem({ ...chat("1001"), code }), "not_found", 404);
    expect(error.message).toBe(INVALID_LINK_CODE);
    expect(await t.run((ctx) => ctx.db.query("channelIdentities").collect())).toHaveLength(0);
  });

  it("gives the same error for unknown, used, expired and superseded codes", async () => {
    const t = setupApi();
    const userId = await seedUser(t);
    const service = serviceClientFor(t);
    const { code: superseded } = await createCode(t, userId);
    const { code: used } = await createCode(t, userId);
    await service.channelLinks.redeem({ ...chat("1001"), code: used });
    const otherUser = await seedUser(t);
    const { code: expired } = await createCode(t, otherUser);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("channelLinkCodes").collect()) {
        if (row.userId === otherUser) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });

    const bodies = [];
    for (const code of ["W".repeat(43), superseded, used, expired]) {
      const response = await raw(t, "POST", "/channel-links/redeem", {
        token: TEST_SERVICE_KEY,
        body: { ...chat("3003"), code },
      });
      expect(response.status).toBe(404);
      bodies.push(response.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("returns conflict when the chat account is already linked to another user", async () => {
    const t = setupApi();
    const { userId: alice, service } = await linkedUser(t, "1001");
    const bob = await seedUser(t);
    const { code } = await createCode(t, bob);
    await expectApiError(service.channelLinks.redeem({ ...chat("1001"), code }), "conflict", 409);
    const identities = await t.run((ctx) => ctx.db.query("channelIdentities").collect());
    expect(identities.map((i) => i.userId)).toEqual([alice]);
    // The code was not consumed: once alice unlinks, bob can use it.
    await service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" });
    const { identity } = await service.channelLinks.redeem({ ...chat("1001"), code });
    const stored = await t.run((ctx) => ctx.db.get(identityId(identity.id)));
    expect(stored!.userId).toBe(bob);
  });

  it("returns conflict when the user already linked another chat account", async () => {
    const t = setupApi();
    const userId = await seedUser(t);
    const { code } = await createCode(t, userId);
    // Simulate a link that landed between code creation and redeem.
    await t.run((ctx) =>
      ctx.db.insert("channelIdentities", {
        userId,
        channel: TG,
        externalUserId: "9999",
        chatId: "9999",
        scopes: ["finance:read"],
        linkedAt: Date.now(),
        consentAt: Date.now(),
      }),
    );
    await expectApiError(serviceClientFor(t).channelLinks.redeem({ ...chat("1001"), code }), "conflict", 409);
  });

  it("never takes a userId from the request", async () => {
    const t = setupApi();
    const userId = await seedUser(t);
    const { code } = await createCode(t, userId);
    const response = await raw(t, "POST", "/channel-links/redeem", {
      token: TEST_SERVICE_KEY,
      body: { ...chat("1001"), code, userId },
    });
    expect(response.status).toBe(400);
  });
});

describe("channelIdentities.resolve", () => {
  it("returns a short-lived token with the identity's scopes that works on /api/v1", async () => {
    const t = setupApi();
    const { userId, service } = await linkedUser(t, "1001", { name: "Alice", currency: "EUR" });
    const account = await seedAccount(t, userId, { currency: "EUR", balance: 10_000 });

    const resolved = await service.channelIdentities.resolve(chat("1001"));
    expect(resolved.scopes).toEqual(["finance:read", "finance:write"]);
    expect(resolved.profile).toEqual({ displayName: "Alice", baseCurrency: "EUR" });
    const verified = await verifyUserToken(resolved.token);
    expect(verified).toMatchObject({ ok: true, claims: { sub: userId } });
    if (verified.ok) {
      expect(verified.claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(RESOLVED_TOKEN_TTL_SECONDS);
      expect(verified.claims.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(RESOLVED_TOKEN_TTL_SECONDS - 60);
    }
    expect(new Date(resolved.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const finance = clientFor(t, resolved.token);
    const { items } = await finance.accounts.list();
    expect(items.map((a) => a.id)).toEqual([account]);
    const adjusted = await finance.accounts.adjust({ id: account, amount: { amountMinor: 500, currency: "EUR" } });
    expect(adjusted.account.balance.amountMinor).toBe(10_500);
  });

  it("read-only identities get a read-only token that can't write", async () => {
    const t = setupApi();
    const { userId, identity, service } = await linkedUser(t, "1001");
    const account = await seedAccount(t, userId, { balance: 100 });
    await asWebUser(t, userId).mutation(api.channelLinks.setReadOnly, {
      identityId: identityId(identity.id),
      readOnly: true,
    });

    const resolved = await service.channelIdentities.resolve(chat("1001"));
    expect(resolved.scopes).toEqual(["finance:read"]);
    const finance = clientFor(t, resolved.token);
    await finance.accounts.list();
    await expectApiError(finance.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } }), "forbidden", 403);
  });

  it("switching to read-only applies to tokens already minted", async () => {
    const t = setupApi();
    const { userId, identity, service } = await linkedUser(t, "1001");
    const account = await seedAccount(t, userId, { balance: 100 });
    const { token } = await service.channelIdentities.resolve(chat("1001"));
    await asWebUser(t, userId).mutation(api.channelLinks.setReadOnly, {
      identityId: identityId(identity.id),
      readOnly: true,
    });
    const finance = clientFor(t, token);
    await finance.accounts.list();
    await expectApiError(finance.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } }), "forbidden", 403);
  });

  it("returns not_found for unknown senders and for another chat (e.g. a group)", async () => {
    const t = setupApi();
    const { service } = await linkedUser(t, "1001");
    await expectApiError(service.channelIdentities.resolve(chat("2002")), "not_found", 404);
    await expectApiError(service.channelIdentities.resolve(chat("1001", { chatId: "-100555" })), "not_found", 404);
  });

  it("returns not_found after unlink, and tokens minted before stop working", async () => {
    const t = setupApi();
    const { service } = await linkedUser(t, "1001");
    const { token } = await service.channelIdentities.resolve(chat("1001"));
    const unlinked = await service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" });
    expect(typeof unlinked.id).toBe("string");
    await expectApiError(service.channelIdentities.resolve(chat("1001")), "not_found", 404);
    await expectApiError(clientFor(t, token).accounts.list(), "unauthorized", 401);
    await expectApiError(service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" }), "not_found", 404);
  });

  it("returns not_found after the user unlinks from the web app", async () => {
    const t = setupApi();
    const { userId, identity, service } = await linkedUser(t, "1001");
    await asWebUser(t, userId).mutation(api.channelLinks.unlink, { identityId: identityId(identity.id) });
    await expectApiError(service.channelIdentities.resolve(chat("1001")), "not_found", 404);
  });

  it("a resolved user token can't call service routes", async () => {
    const t = setupApi();
    const { service } = await linkedUser(t, "1001");
    const { token } = await service.channelIdentities.resolve(chat("1001"));
    const asUserToken = serviceClientFor(t, token);
    const error = await expectApiError(asUserToken.channelIdentities.resolve(chat("1001")), "unauthorized", 401);
    expect(error).toBeInstanceOf(FinanceApiError);
    await expectApiError(asUserToken.channelIdentities.unlink({ channel: TG, externalUserId: "1001" }), "unauthorized", 401);
    // Still linked.
    await service.channelIdentities.resolve(chat("1001"));
  });

  it("the service key can't call user routes", async () => {
    const t = setupApi();
    await linkedUser(t, "1001");
    await expectApiError(clientFor(t, TEST_SERVICE_KEY).accounts.list(), "unauthorized", 401);
  });
});

describe("link code cleanup", () => {
  it("purges expired codes, used or not, and keeps live ones", async () => {
    const t = setupApi();
    const alice = await seedUser(t);
    const bob = await seedUser(t);
    const { code } = await createCode(t, alice);
    await serviceClientFor(t).channelLinks.redeem({ ...chat("1001"), code });
    await createCode(t, bob);

    expect(await t.mutation(internal.channelLinks.purgeExpiredCodes, {})).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("channelLinkCodes").collect())).toHaveLength(2);
    const later = Date.now() + 11 * 60 * 1000;
    expect(await t.mutation(internal.channelLinks.purgeExpiredCodes, { now: later })).toBe(2);
    expect(await t.run((ctx) => ctx.db.query("channelLinkCodes").collect())).toHaveLength(0);
  });
});
