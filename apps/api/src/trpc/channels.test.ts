import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  ApiError,
  clientFor,
  expectApiError,
  getAccountRow,
  linkedChat,
  raw,
  seedAccount,
  seedUser,
  serviceClientFor,
  tokenFor,
  type TestApp,
} from "../../test/api";
import { TEST_SERVICE_KEY, testApp, testTokens } from "../../test/app";
import { testDb } from "../../test/db";
import { channelIdentities, channelLinkCodes } from "../db/schema";
import { hashLinkCode, INVALID_LINK_CODE } from "../domain/channelLinks";
import { RESOLVED_TOKEN_TTL_SECONDS } from "./service";

const TG = "telegram" as const;
const chat = (id: string, extra: { chatId?: string; username?: string } = {}) => ({
  channel: TG,
  externalUserId: id,
  chatId: extra.chatId ?? id,
  ...(extra.username ? { username: extra.username } : {}),
});

const codeRows = () => testDb().select().from(channelLinkCodes);
const identityRows = () => testDb().select().from(channelIdentities);

async function createCode(app: TestApp, userId: string) {
  return await clientFor(app, await tokenFor(userId)).chatLinks.createCode({ channel: TG, consent: true });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("channelLinks.redeem", () => {
  it("creates the identity for the code's owner with read+write scopes and stores only the hash", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code, expiresAt } = await createCode(app, userId);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);

    const rows = await codeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBe(hashLinkCode(code));
    expect(JSON.stringify(rows)).not.toContain(code);

    const { identity } = await serviceClientFor(app).channelLinks.redeem({ ...chat("1001", { username: "alice" }), code });
    expect(identity).toMatchObject({
      channel: "telegram",
      externalUserId: "1001",
      chatId: "1001",
      username: "alice",
      scopes: ["finance:read", "finance:write"],
    });
    const stored = await identityRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.userId).toBe(userId);
    expect(stored[0]!.consentAt.getTime()).toBeLessThanOrEqual(stored[0]!.linkedAt.getTime());
  });

  it("is single-use", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code } = await createCode(app, userId);
    const service = serviceClientFor(app);
    await service.channelLinks.redeem({ ...chat("1001"), code });
    await testDb().update(channelIdentities).set({ unlinkedAt: new Date() });
    const again = await expectApiError(service.channelLinks.redeem({ ...chat("1001"), code }), "not_found", 404);
    expect(again.message).toBe(INVALID_LINK_CODE);
    const other = await expectApiError(service.channelLinks.redeem({ ...chat("2002"), code }), "not_found", 404);
    expect(other.message).toBe(INVALID_LINK_CODE);
  });

  it("rejects an expired code", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code } = await createCode(app, userId);
    await testDb().update(channelLinkCodes).set({ expiresAt: new Date(Date.now() - 1) });
    const error = await expectApiError(serviceClientFor(app).channelLinks.redeem({ ...chat("1001"), code }), "not_found", 404);
    expect(error.message).toBe(INVALID_LINK_CODE);
    expect(await identityRows()).toHaveLength(0);
  });

  it("gives the same error for unknown, used, expired and superseded codes", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const service = serviceClientFor(app);
    const { code: superseded } = await createCode(app, userId);
    const { code: used } = await createCode(app, userId);
    await service.channelLinks.redeem({ ...chat("1001"), code: used });
    const otherUser = await seedUser();
    const { code: expired } = await createCode(app, otherUser);
    await testDb()
      .update(channelLinkCodes)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(channelLinkCodes.userId, otherUser));

    const bodies = [];
    for (const code of ["W".repeat(43), superseded, used, expired]) {
      const response = await raw(app, "channelLinks.redeem", { ...chat("3003"), code }, { token: TEST_SERVICE_KEY });
      expect(response.status).toBe(404);
      bodies.push(response.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("returns conflict when the chat account is already linked to another user", async () => {
    const { app } = testApp();
    const { userId: alice, service } = await linkedChat(app, { externalUserId: "1001" });
    const bob = await seedUser();
    const { code } = await createCode(app, bob);
    await expectApiError(service.channelLinks.redeem({ ...chat("1001"), code }), "conflict", 409);
    expect((await identityRows()).map((i) => i.userId)).toEqual([alice]);
    await service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" });
    const { identity } = await service.channelLinks.redeem({ ...chat("1001"), code });
    const [stored] = await testDb().select().from(channelIdentities).where(eq(channelIdentities.id, identity.id));
    expect(stored!.userId).toBe(bob);
  });

  it("returns conflict when the user already linked another chat account", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code } = await createCode(app, userId);
    await testDb()
      .insert(channelIdentities)
      .values({
        userId,
        channel: TG,
        externalUserId: "9999",
        chatId: "9999",
        scopes: ["finance:read"],
        linkedAt: new Date(),
        consentAt: new Date(),
      });
    await expectApiError(serviceClientFor(app).channelLinks.redeem({ ...chat("1001"), code }), "conflict", 409);
  });

  it("refuses a code sent from a group chat and leaves it usable", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code } = await createCode(app, userId);
    const service = serviceClientFor(app);
    await expectApiError(service.channelLinks.redeem({ ...chat("1001", { chatId: "-1005551234" }), code }), "validation_failed", 400);
    expect(await identityRows()).toHaveLength(0);
    await service.channelLinks.redeem({ ...chat("1001"), code });
  });

  it("never takes a userId from the request", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code } = await createCode(app, userId);
    const response = await raw(app, "channelLinks.redeem", { ...chat("1001"), code, userId }, { token: TEST_SERVICE_KEY });
    expect(response.status).toBe(400);
  });

  it("links one chat account to one user when two users' codes arrive from it at once", async () => {
    const { app } = testApp();
    const codes = await Promise.all([seedUser(), seedUser()].map(async (user) => (await createCode(app, await user)).code));
    const service = serviceClientFor(app);
    const results = await Promise.allSettled(codes.map((code) => service.channelLinks.redeem({ ...chat("1001"), code })));
    expect(results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code: string }).code)).sort()).toEqual(["conflict", "ok"]);
    expect(await identityRows()).toHaveLength(1);
  });

  it("links exactly once under concurrent redeems of one code", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const { code } = await createCode(app, userId);
    const service = serviceClientFor(app);
    const results = await Promise.allSettled([
      service.channelLinks.redeem({ ...chat("1001"), code }),
      service.channelLinks.redeem({ ...chat("2002"), code }),
      service.channelLinks.redeem({ ...chat("3003"), code }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "not_found" });
    }
    expect(await identityRows()).toHaveLength(1);
  });
});

describe("channelIdentities.resolve", () => {
  it("returns a short-lived token with the identity's scopes that works on /api/v1", async () => {
    const { app } = testApp();
    const { userId, service } = await linkedChat(app, { name: "Alice", baseCurrency: "EUR" });
    const account = await seedAccount(userId, { currency: "EUR", balance: 10_000 });

    const resolved = await service.channelIdentities.resolve(chat("1001"));
    expect(resolved.scopes).toEqual(["finance:read", "finance:write", "agent:state"]);
    expect(resolved.profile).toEqual({ displayName: "Alice", baseCurrency: "EUR" });
    const verified = await testTokens.verify(resolved.token);
    expect(verified).toMatchObject({ ok: true, claims: { sub: userId, cid: resolved.identity.id } });
    if (verified.ok) {
      expect(verified.claims.exp - nowSeconds()).toBeLessThanOrEqual(RESOLVED_TOKEN_TTL_SECONDS);
      expect(verified.claims.exp - nowSeconds()).toBeGreaterThan(RESOLVED_TOKEN_TTL_SECONDS - 60);
    }
    expect(new Date(resolved.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const finance = clientFor(app, resolved.token);
    const { items } = await finance.accounts.list();
    expect(items.map((a) => a.id)).toEqual([account]);
    const adjusted = await finance.accounts.adjust({ id: account, amount: { amountMinor: 500, currency: "EUR" } });
    expect(adjusted.account.balance.amountMinor).toBe(10_500);
  });

  it("read-only identities get a read-only token that can't write", async () => {
    const { app } = testApp();
    const { userId, service } = await linkedChat(app, { readOnly: true });
    const account = await seedAccount(userId, { balance: 100 });

    const resolved = await service.channelIdentities.resolve(chat("1001"));
    expect(resolved.scopes).toEqual(["finance:read", "agent:state"]);
    expect(resolved.identity.scopes).toEqual(["finance:read"]);
    const finance = clientFor(app, resolved.token);
    await finance.accounts.list();
    await expectApiError(finance.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } }), "forbidden", 403);
  });

  it("switching to read-only applies to tokens already minted", async () => {
    const { app } = testApp();
    const { userId, identityId, web, token } = await linkedChat(app);
    const account = await seedAccount(userId, { balance: 100 });
    await web.chatLinks.setReadOnly({ id: identityId, readOnly: true });
    const finance = clientFor(app, token);
    await finance.accounts.list();
    await expectApiError(finance.accounts.adjust({ id: account, amount: { amountMinor: 1, currency: "USD" } }), "forbidden", 403);
    expect((await getAccountRow(account))?.balance).toBe(100);
  });

  it("a revoked token can't replay a write through its Idempotency-Key", async () => {
    const { app } = testApp();
    const { userId, service, token } = await linkedChat(app);
    const account = await seedAccount(userId, { balance: 100 });
    const finance = clientFor(app, token);
    const input = { id: account, amount: { amountMinor: 1, currency: "USD" } };
    await finance.accounts.adjust(input, { idempotencyKey: "replay-key-0001" });
    await service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" });
    await expectApiError(finance.accounts.adjust(input, { idempotencyKey: "replay-key-0001" }), "unauthorized", 401);
  });

  it("returns not_found for unknown senders and for another chat (e.g. a group)", async () => {
    const { app } = testApp();
    const { service } = await linkedChat(app);
    await expectApiError(service.channelIdentities.resolve(chat("2002")), "not_found", 404);
    await expectApiError(service.channelIdentities.resolve(chat("1001", { chatId: "-100555" })), "not_found", 404);
  });

  it("returns not_found after unlink, and tokens minted before stop working", async () => {
    const { app } = testApp();
    const { service, token, identityId } = await linkedChat(app);
    const unlinked = await service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" });
    expect(unlinked.id).toBe(identityId);
    await expectApiError(service.channelIdentities.resolve(chat("1001")), "not_found", 404);
    await expectApiError(clientFor(app, token).accounts.list(), "unauthorized", 401);
    await expectApiError(service.channelIdentities.unlink({ channel: TG, externalUserId: "1001" }), "not_found", 404);
  });

  it("returns not_found after the user unlinks from the web app", async () => {
    const { app } = testApp();
    const { identityId, service, web } = await linkedChat(app);
    await web.chatLinks.unlink({ id: identityId });
    await expectApiError(service.channelIdentities.resolve(chat("1001")), "not_found", 404);
  });

  it("a resolved user token can't call service routes", async () => {
    const { app } = testApp();
    const { service, token } = await linkedChat(app);
    const asUserToken = serviceClientFor(app, token);
    const error = await expectApiError(asUserToken.channelIdentities.resolve(chat("1001")), "unauthorized", 401);
    expect(error).toBeInstanceOf(ApiError);
    await expectApiError(asUserToken.channelIdentities.unlink({ channel: TG, externalUserId: "1001" }), "unauthorized", 401);
    await service.channelIdentities.resolve(chat("1001"));
  });

  it("the service key can't call user routes", async () => {
    const { app } = testApp();
    await linkedChat(app);
    await expectApiError(clientFor(app, TEST_SERVICE_KEY).accounts.list(), "unauthorized", 401);
  });
});
