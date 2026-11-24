import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  ALL_SCOPES,
  clientFor,
  expectApiError,
  expectError,
  linkedChat,
  raw,
  seedUser,
  serviceClientFor,
  tokenFor,
  type TestApp,
} from "../../../test/api";
import { testApp } from "../../../test/app";
import { testDb } from "../../../test/db";
import { agentMessages, agentPendingActions, agentSessions, apiIdempotencyKeys, channelIdentities, channelLinkCodes } from "../../db/schema";

const TG = "telegram" as const;
const LINKED_AT = new Date(1_700_000_000_000);

async function newUser(app: TestApp) {
  const userId = await seedUser();
  return { userId, web: clientFor(app, await tokenFor(userId)) };
}

async function seedIdentity(userId: string, externalUserId = "1001") {
  const [row] = await testDb()
    .insert(channelIdentities)
    .values({
      userId,
      channel: TG,
      externalUserId,
      chatId: externalUserId,
      username: "tg_user",
      scopes: ["finance:read", "finance:write"],
      linkedAt: LINKED_AT,
      consentAt: LINKED_AT,
    })
    .returning({ id: channelIdentities.id });
  return row!.id;
}

const identity = async (id: string) => (await testDb().select().from(channelIdentities).where(eq(channelIdentities.id, id)))[0];

describe("chatLinks (web)", () => {
  it("requires authentication", async () => {
    const { app } = testApp();
    expectError(await raw(app, "POST", "/chat-links/codes", { body: { channel: TG, consent: true } }), "unauthorized", 401);
    expectError(await raw(app, "GET", "/chat-links"), "unauthorized", 401);
    expectError(await raw(app, "DELETE", "/chat-history"), "unauthorized", 401);
  });

  it("is not available to chat tokens", async () => {
    const { app } = testApp();
    const chat = await linkedChat(app);
    await expectApiError(chat.agent.chatLinks.list(), "forbidden", 403);
    await expectApiError(chat.agent.chatLinks.unlink({ id: chat.identityId }), "forbidden", 403);
    await expectApiError(chat.agent.chatHistory.delete(), "forbidden", 403);
    expect(await identity(chat.identityId)).toMatchObject({ unlinkedAt: null });
  });

  it("requires consent to create a code and stores nothing without it", async () => {
    const { app } = testApp();
    const { userId } = await newUser(app);
    const response = await raw(app, "POST", "/chat-links/codes", { token: await tokenFor(userId), body: { channel: TG, consent: false } });
    expectError(response, "validation_failed", 400);
    expect(JSON.stringify(response.body.error?.details)).toContain("Consent is required");
    expect(await testDb().select().from(channelLinkCodes)).toHaveLength(0);
  });

  it("creates distinct high-entropy codes, keeps only the newest pending one, and stores no copy of it", async () => {
    const { app } = testApp();
    const { web } = await newUser(app);
    const first = await web.chatLinks.createCode({ channel: TG, consent: true });
    const second = await web.chatLinks.createCode({ channel: TG, consent: true });
    expect(first.code).not.toBe(second.code);
    expect(second.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await testDb().select().from(channelLinkCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consentAt.getTime()).toBeGreaterThan(0);
    expect(await testDb().select().from(apiIdempotencyKeys)).toHaveLength(0);
  });

  it("concurrent creates leave one code, and only the code that was stored works", async () => {
    const { app } = testApp();
    const { web } = await newUser(app);
    const codes = await Promise.all([1, 2, 3, 4].map(() => web.chatLinks.createCode({ channel: TG, consent: true })));
    const rows = await testDb().select().from(channelLinkCodes);
    expect(rows).toHaveLength(1);
    const service = serviceClientFor(app);
    const results = await Promise.allSettled(
      codes.map(({ code }, i) => service.channelLinks.redeem({ channel: TG, externalUserId: `${i + 1}`, chatId: `${i + 1}`, code })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("replaces used codes too, so old rows never pile up", async () => {
    const { app } = testApp();
    const { userId, web } = await newUser(app);
    await testDb()
      .insert(channelLinkCodes)
      .values({ userId, channel: TG, codeHash: "used-0", expiresAt: new Date(Date.now() + 60_000), usedAt: new Date(), consentAt: new Date() });
    await web.chatLinks.createCode({ channel: TG, consent: true });
    await web.chatLinks.createCode({ channel: TG, consent: true });
    const rows = await testDb().select().from(channelLinkCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedAt).toBeNull();
  });

  it("refuses a new code while the channel is linked", async () => {
    const { app } = testApp();
    const { userId, web } = await newUser(app);
    await seedIdentity(userId);
    const error = await expectApiError(web.chatLinks.createCode({ channel: TG, consent: true }), "conflict", 409);
    expect(error.message).toContain("already linked");
  });

  it("lists only the current user's active links", async () => {
    const { app } = testApp();
    const alice = await newUser(app);
    const bob = await newUser(app);
    const aliceIdentity = await seedIdentity(alice.userId, "1001");
    await seedIdentity(bob.userId, "2002");

    expect(await alice.web.chatLinks.list()).toEqual({
      items: [{ id: aliceIdentity, channel: "telegram", username: "tg_user", linkedAt: LINKED_AT.toISOString(), readOnly: false }],
      botUsernames: {},
    });

    expect(await alice.web.chatLinks.unlink({ id: aliceIdentity })).toEqual({ id: aliceIdentity });
    expect(await alice.web.chatLinks.list()).toEqual({ items: [], botUsernames: {} });
    expect((await bob.web.chatLinks.list()).items).toHaveLength(1);
  });

  it("names the configured bot, so the web can link to it", async () => {
    const { app } = testApp({ operationSettings: { telegramBotUsername: "dalva_test_bot" } });
    const { web } = await newUser(app);
    expect(await web.chatLinks.list()).toEqual({ items: [], botUsernames: { telegram: "dalva_test_bot" } });
  });

  it("toggles read-only by switching scopes", async () => {
    const { app } = testApp();
    const { userId, web } = await newUser(app);
    const id = await seedIdentity(userId);
    const { link } = await web.chatLinks.setReadOnly({ id, readOnly: true });
    expect(link).toMatchObject({ id, readOnly: true });
    expect((await identity(id))!.scopes).toEqual(["finance:read"]);
    expect((await web.chatLinks.list()).items[0]!.readOnly).toBe(true);
    await web.chatLinks.setReadOnly({ id, readOnly: false });
    expect((await identity(id))!.scopes).toEqual(["finance:read", "finance:write"]);
  });

  it("can't unlink or change another user's link", async () => {
    const { app } = testApp();
    const alice = await newUser(app);
    const bob = await newUser(app);
    const aliceIdentity = await seedIdentity(alice.userId);
    await expectApiError(bob.web.chatLinks.unlink({ id: aliceIdentity }), "not_found", 404);
    await expectApiError(bob.web.chatLinks.setReadOnly({ id: aliceIdentity, readOnly: true }), "not_found", 404);
    expect(await identity(aliceIdentity)).toMatchObject({ scopes: ["finance:read", "finance:write"], unlinkedAt: null });
  });

  it("can't change a link that is already unlinked", async () => {
    const { app } = testApp();
    const { userId, web } = await newUser(app);
    const id = await seedIdentity(userId);
    await web.chatLinks.unlink({ id });
    await expectApiError(web.chatLinks.unlink({ id }), "not_found", 404);
    await expectApiError(web.chatLinks.setReadOnly({ id, readOnly: true }), "not_found", 404);
  });

  it("answers validation_failed for an id that can't be an identity", async () => {
    const { app } = testApp();
    const { web } = await newUser(app);
    await expectApiError(web.chatLinks.unlink({ id: "not-a-uuid" }), "validation_failed", 400);
  });

  it("needs finance:write to change links", async () => {
    const { app } = testApp();
    const userId = await seedUser();
    const id = await seedIdentity(userId);
    const readOnly = clientFor(app, await tokenFor(userId, ALL_SCOPES.filter((s) => s !== "finance:write")));
    await readOnly.chatLinks.list();
    await expectApiError(readOnly.chatLinks.unlink({ id }), "forbidden", 403);
  });
});

describe("chatHistory.delete (web)", () => {
  async function seedHistory(userId: string, identityId: string, messages: number) {
    const now = new Date();
    const [session] = await testDb()
      .insert(agentSessions)
      .values({ userId, identityId, channel: TG, chatId: "c", startedAt: now, lastActivityAt: now, messageCount: messages })
      .returning({ id: agentSessions.id });
    if (messages > 0) {
      await testDb()
        .insert(agentMessages)
        .values(Array.from({ length: messages }, (_, i) => ({ sessionId: session!.id, userId, role: "user" as const, content: "{}", seq: i + 1 })));
    }
    await testDb()
      .insert(agentPendingActions)
      .values({ userId, sessionId: session!.id, operation: "transactions.create", input: "{}", summary: "x", status: "pending", expiresAt: now, updatedAt: now });
  }

  const counts = async () => ({
    sessions: (await testDb().select().from(agentSessions)).length,
    messages: (await testDb().select().from(agentMessages)).length,
    actions: (await testDb().select().from(agentPendingActions)).length,
  });

  it("deletes the signed-in user's history across identities and leaves other users alone", async () => {
    const { app } = testApp();
    const alice = await newUser(app);
    const bob = await newUser(app);
    const aliceIdentity = await seedIdentity(alice.userId, "1");
    const bobIdentity = await seedIdentity(bob.userId, "2");
    await seedHistory(alice.userId, aliceIdentity, 3);
    await seedHistory(alice.userId, aliceIdentity, 2);
    await seedHistory(bob.userId, bobIdentity, 4);

    expect(await alice.web.chatHistory.delete()).toEqual({ deleted: true });
    expect(await counts()).toEqual({ sessions: 1, messages: 4, actions: 1 });
    const left = await testDb().select().from(agentSessions);
    expect(left[0]!.userId).toBe(bob.userId);
  });

  it("deletes a large history in one request", async () => {
    const { app } = testApp();
    const alice = await newUser(app);
    const id = await seedIdentity(alice.userId, "1");
    await seedHistory(alice.userId, id, 700);
    await alice.web.chatHistory.delete();
    expect(await counts()).toEqual({ sessions: 0, messages: 0, actions: 0 });
  });

  it("unlinking from the web deletes a large history of that identity only", async () => {
    const { app } = testApp();
    const alice = await newUser(app);
    const bob = await newUser(app);
    const aliceIdentity = await seedIdentity(alice.userId, "1");
    const bobIdentity = await seedIdentity(bob.userId, "2");
    await seedHistory(alice.userId, aliceIdentity, 700);
    await seedHistory(bob.userId, bobIdentity, 3);
    await alice.web.chatLinks.unlink({ id: aliceIdentity });
    expect(await counts()).toEqual({ sessions: 1, messages: 3, actions: 1 });
  });
});
