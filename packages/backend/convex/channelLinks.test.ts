import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setupTest } from "./test.setup";

type T = ReturnType<typeof setupTest>;
const TG = "telegram" as const;

async function newUser(t: T) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  return { userId: userId as string, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function seedIdentity(t: T, userId: string, externalUserId = "1001") {
  return await t.run((ctx) =>
    ctx.db.insert("channelIdentities", {
      userId,
      channel: TG,
      externalUserId,
      chatId: externalUserId,
      username: "tg_user",
      scopes: ["finance:read", "finance:write"],
      linkedAt: 1_700_000_000_000,
      consentAt: 1_700_000_000_000,
    }),
  );
}

describe("channelLinks (web)", () => {
  it("requires authentication", async () => {
    const t = setupTest();
    await expect(t.action(api.channelLinks.createLinkCode, { channel: TG, consent: true })).rejects.toThrow(
      "Not authenticated",
    );
    await expect(t.query(api.channelLinks.listMine, {})).rejects.toThrow("Not authenticated");
  });

  it("requires consent to create a code and stores nothing without it", async () => {
    const t = setupTest();
    const { as } = await newUser(t);
    await expect(as.action(api.channelLinks.createLinkCode, { channel: TG, consent: false })).rejects.toThrow(
      "Consent is required",
    );
    expect(await t.run((ctx) => ctx.db.query("channelLinkCodes").collect())).toHaveLength(0);
  });

  it("creates distinct high-entropy codes and keeps only the newest pending one", async () => {
    const t = setupTest();
    const { as } = await newUser(t);
    const first = await as.action(api.channelLinks.createLinkCode, { channel: TG, consent: true });
    const second = await as.action(api.channelLinks.createLinkCode, { channel: TG, consent: true });
    expect(first.code).not.toBe(second.code);
    expect(second.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await t.run((ctx) => ctx.db.query("channelLinkCodes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consentAt).toBeGreaterThan(0);
  });

  it("replaces used codes too, so old rows never pile up", async () => {
    const t = setupTest();
    const { userId, as } = await newUser(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("channelLinkCodes", {
          userId,
          channel: TG,
          codeHash: `used-${i}`,
          expiresAt: Date.now() + 60_000,
          usedAt: Date.now(),
          consentAt: Date.now(),
        });
      }
    });
    await as.action(api.channelLinks.createLinkCode, { channel: TG, consent: true });
    await as.action(api.channelLinks.createLinkCode, { channel: TG, consent: true });
    const rows = await t.run((ctx) => ctx.db.query("channelLinkCodes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedAt).toBeUndefined();
  });

  it("refuses a new code while the channel is linked", async () => {
    const t = setupTest();
    const { userId, as } = await newUser(t);
    await seedIdentity(t, userId);
    await expect(as.action(api.channelLinks.createLinkCode, { channel: TG, consent: true })).rejects.toThrow(
      "already linked",
    );
  });

  it("lists only the current user's active links", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const bob = await newUser(t);
    const aliceIdentity = await seedIdentity(t, alice.userId, "1001");
    await seedIdentity(t, bob.userId, "2002");

    const mine = await alice.as.query(api.channelLinks.listMine, {});
    expect(mine).toEqual([
      { _id: aliceIdentity, channel: "telegram", username: "tg_user", linkedAt: 1_700_000_000_000, readOnly: false },
    ]);

    await alice.as.mutation(api.channelLinks.unlink, { identityId: aliceIdentity });
    expect(await alice.as.query(api.channelLinks.listMine, {})).toEqual([]);
    expect(await bob.as.query(api.channelLinks.listMine, {})).toHaveLength(1);
  });

  it("toggles read-only by switching scopes", async () => {
    const t = setupTest();
    const { userId, as } = await newUser(t);
    const id = await seedIdentity(t, userId);
    await as.mutation(api.channelLinks.setReadOnly, { identityId: id, readOnly: true });
    expect((await t.run((ctx) => ctx.db.get(id)))!.scopes).toEqual(["finance:read"]);
    expect((await as.query(api.channelLinks.listMine, {}))[0]!.readOnly).toBe(true);
    await as.mutation(api.channelLinks.setReadOnly, { identityId: id, readOnly: false });
    expect((await t.run((ctx) => ctx.db.get(id)))!.scopes).toEqual(["finance:read", "finance:write"]);
  });

  it("can't unlink or change another user's link", async () => {
    const t = setupTest();
    const alice = await newUser(t);
    const bob = await newUser(t);
    const aliceIdentity = await seedIdentity(t, alice.userId);
    await expect(bob.as.mutation(api.channelLinks.unlink, { identityId: aliceIdentity })).rejects.toThrow("not found");
    await expect(
      bob.as.mutation(api.channelLinks.setReadOnly, { identityId: aliceIdentity, readOnly: true }),
    ).rejects.toThrow("not found");
    const stored = await t.run((ctx) => ctx.db.get(aliceIdentity));
    expect(stored).toMatchObject({ scopes: ["finance:read", "finance:write"] });
    expect(stored!.unlinkedAt).toBeUndefined();
  });

  it("can't change a link that is already unlinked", async () => {
    const t = setupTest();
    const { userId, as } = await newUser(t);
    const id: Id<"channelIdentities"> = await seedIdentity(t, userId);
    await as.mutation(api.channelLinks.unlink, { identityId: id });
    await expect(as.mutation(api.channelLinks.unlink, { identityId: id })).rejects.toThrow("not found");
    await expect(as.mutation(api.channelLinks.setReadOnly, { identityId: id, readOnly: true })).rejects.toThrow(
      "not found",
    );
  });
});
