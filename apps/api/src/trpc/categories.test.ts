import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  clientFor,
  expectApiError,
  expectOk,
  expectError,
  oneUser,
  raw,
  seedChannelIdentity,
  tokenFor,
  transactionRows,
  twoUsers,
} from "../../test/api";
import { testDb } from "../../test/db";
import { categories, subcategories, transactions } from "../db/schema";

const KEY = "categories-test-key";

async function seedCategory(userId: string, extra: { name?: string; archived?: boolean } = {}) {
  const [row] = await testDb()
    .insert(categories)
    .values({ userId, name: extra.name ?? "Food", type: "expense", archived: extra.archived ?? false })
    .returning({ id: categories.id });
  return row!.id;
}

async function seedSub(userId: string, categoryId: string, extra: { archived?: boolean; name?: string } = {}) {
  const [row] = await testDb()
    .insert(subcategories)
    .values({ userId, categoryId, name: extra.name ?? "Groceries", archived: extra.archived ?? false, sortOrder: 0 })
    .returning({ id: subcategories.id });
  return row!.id;
}

describe("api/v1 categories and subcategories", () => {
  it("lists categories, hiding archived ones unless asked", async () => {
    const { app, alice, asAlice } = await twoUsers();
    const food = await seedCategory(alice);
    const old = await seedCategory(alice, { name: "Old", archived: true });

    const list = expectOk(await raw(app, "categories.list", {}, { token: await tokenFor(alice) }));
    expect(list).toEqual({ items: [{ id: food, name: "Food", type: "expense", isDefault: false }] });
    const all = await asAlice.categories.list({ includeArchived: true });
    expect(all.items.map((c) => c.id)).toEqual([food, old]);
    expect(all.items[1]).toMatchObject({ archived: true });
  });

  it("lists subcategories for one category or all of them", async () => {
    const { app, alice, asAlice } = await twoUsers();
    const food = await seedCategory(alice);
    const fun = await seedCategory(alice, { name: "Fun" });
    const groceries = await seedSub(alice, food);
    const archived = await seedSub(alice, food, { archived: true, name: "Old" });
    const games = await seedSub(alice, fun, { name: "Games" });

    const one = expectOk(await raw(app, "subcategories.list", { categoryId: food }, { token: await tokenFor(alice) }));
    expect(one).toEqual({ items: [{ id: groceries, categoryId: food, name: "Groceries", archived: false, sortOrder: 0 }] });
    expect((await asAlice.subcategories.list({ categoryId: food, includeArchived: true })).items.map((s) => s.id)).toEqual([
      groceries,
      archived,
    ]);
    expect((await asAlice.subcategories.list()).items.map((s) => s.id)).toEqual([groceries, games]);
  });

  it("validates ids and isolates users", async () => {
    const { alice, asAlice, asBob } = await twoUsers();
    const food = await seedCategory(alice);
    await seedSub(alice, food);
    await expectApiError(asAlice.subcategories.list({ categoryId: "nope" }), "validation_failed", 400);
    await expectApiError(asAlice.categories.update({ id: "nope", name: "x" }), "validation_failed", 400);
    await expectApiError(asBob.subcategories.list({ categoryId: food }), "not_found", 404);
    expect((await asBob.categories.list({ includeArchived: true })).items).toEqual([]);
    expect((await asBob.subcategories.list({ includeArchived: true })).items).toEqual([]);
  });

  it("lists the defaults and seeds them once, as onboarding does", async () => {
    const { client } = await oneUser();
    const { items: defaults } = await client.categories.defaults();
    expect(defaults).toHaveLength(15);
    expect(defaults[0]).toEqual({ name: "Salary", type: "income", icon: "banknote", color: "#2F5711" });

    const { items } = await client.categories.seedDefaults({ selectedNames: ["Salary", "Transport", "Nope"] });
    expect(items).toEqual([
      { id: items[0]!.id, name: "Salary", type: "income", icon: "banknote", color: "#2F5711", isDefault: true, sortOrder: 0 },
      { id: items[1]!.id, name: "Transport", type: "expense", icon: "car", color: "#3B82F6", isDefault: true, sortOrder: 1 },
    ]);
    expect(await client.categories.seedDefaults({ selectedNames: [] })).toEqual({ items: [] });
    expect((await client.categories.list()).items.map((c) => c.name)).toEqual(["Salary", "Transport"]);
  });

  it("creates, updates, archives, restores and deletes categories and subcategories", async () => {
    const { client } = await oneUser();

    const { category } = await client.categories.create({ name: " Pets ", type: "expense", icon: "paw-print", color: "#8B4513" });
    expect(category).toEqual({
      id: category.id,
      name: "Pets",
      type: "expense",
      icon: "paw-print",
      color: "#8B4513",
      isDefault: false,
      sortOrder: 0,
    });
    expect((await client.categories.update({ id: category.id, name: "Animals" })).category).toMatchObject({
      name: "Animals",
      icon: "paw-print",
    });

    const { subcategory } = await client.subcategories.create({ categoryId: category.id, name: " Food " });
    expect(subcategory).toEqual({ id: subcategory.id, categoryId: category.id, name: "Food", archived: false, sortOrder: 0 });
    expect((await client.subcategories.update({ id: subcategory.id, name: "Vet" })).subcategory.name).toBe("Vet");
    expect((await client.subcategories.archive({ id: subcategory.id })).subcategory.archived).toBe(true);
    expect((await client.subcategories.restore({ id: subcategory.id })).subcategory.archived).toBe(false);

    expect((await client.categories.archive({ id: category.id })).category.archived).toBe(true);
    expect((await client.categories.list()).items).toEqual([]);
    expect((await client.subcategories.list({ includeArchived: true })).items[0]?.archived).toBe(true);
    expect((await client.categories.restore({ id: category.id })).category).not.toHaveProperty("archived");
    expect((await client.subcategories.list()).items).toEqual([]);

    expect(await client.subcategories.delete({ id: subcategory.id })).toEqual({ id: subcategory.id });
    expect(await client.categories.delete({ id: category.id })).toEqual({ id: category.id });
    expect((await client.categories.list({ includeArchived: true })).items).toEqual([]);
    await expectApiError(client.categories.delete({ id: category.id }), "not_found", 404);
  });

  it("deletes a category in use: its transactions stay, uncategorised", async () => {
    const { alice, asAlice, aliceAccount } = await twoUsers();
    const food = await seedCategory(alice);
    const groceries = await seedSub(alice, food);
    await testDb()
      .insert(transactions)
      .values({ userId: alice, type: "expense", amount: 500, accountId: aliceAccount, date: "2026-01-01", categoryId: food, subcategoryId: groceries });

    await asAlice.categories.delete({ id: food });
    expect(await transactionRows()).toEqual([expect.objectContaining({ amount: 500, categoryId: null, subcategoryId: null })]);
    expect(await testDb().select().from(subcategories).where(eq(subcategories.id, groceries))).toEqual([]);
  });

  it("rejects blank names before they reach the database", async () => {
    const { app, user } = await oneUser();
    const token = await tokenFor(user);
    const food = await seedCategory(user);
    const sub = await seedSub(user, food);
    const send = (path: string, input: unknown) => raw(app, path, input, { token, idempotencyKey: KEY });
    expectError(await send("categories.create", { name: "   ", type: "expense", icon: "a", color: "#000" }), "validation_failed", 400);
    expectError(await send("subcategories.create", { categoryId: food, name: "  " }), "validation_failed", 400);
    expectError(await send("subcategories.update", { id: sub, name: "  " }), "validation_failed", 400);
    expect(await testDb().select().from(categories)).toHaveLength(1);
  });

  it("refuses another user's rows", async () => {
    const { alice, asBob } = await twoUsers();
    const food = await seedCategory(alice);
    const sub = await seedSub(alice, food);
    await expectApiError(asBob.categories.update({ id: food, name: "x" }), "not_found", 404);
    await expectApiError(asBob.categories.archive({ id: food }), "not_found", 404);
    await expectApiError(asBob.categories.restore({ id: food }), "not_found", 404);
    await expectApiError(asBob.categories.delete({ id: food }), "not_found", 404);
    const parent = await expectApiError(asBob.subcategories.create({ categoryId: food, name: "x" }), "not_found", 404);
    expect(parent.message).toBe("Parent category not found");
    await expectApiError(asBob.subcategories.update({ id: sub, name: "x" }), "not_found", 404);
    await expectApiError(asBob.subcategories.archive({ id: sub }), "not_found", 404);
    await expectApiError(asBob.subcategories.restore({ id: sub }), "not_found", 404);
    await expectApiError(asBob.subcategories.delete({ id: sub }), "not_found", 404);

    expect(await testDb().select().from(categories)).toEqual([expect.objectContaining({ userId: alice, name: "Food", archived: false })]);
    expect(await testDb().select().from(subcategories)).toEqual([
      expect.objectContaining({ userId: alice, name: "Groceries", archived: false }),
    ]);
  });

  it("refuses chat tokens on the web-only routes, but lets them list", async () => {
    const { app, user } = await oneUser();
    const food = await seedCategory(user);
    const chat = clientFor(app, await tokenFor(user, undefined, { channelIdentityId: await seedChannelIdentity(user) }));
    const error = await expectApiError(chat.categories.defaults(), "forbidden", 403);
    expect(error.message).toBe("Not available to chat tokens");
    await expectApiError(chat.categories.seedDefaults({ selectedNames: [] }), "forbidden", 403);
    await expectApiError(chat.categories.create({ name: "x", type: "expense", icon: "a", color: "#000" }), "forbidden", 403);
    await expectApiError(chat.categories.delete({ id: food }), "forbidden", 403);
    await expectApiError(chat.subcategories.create({ categoryId: food, name: "x" }), "forbidden", 403);
    expect((await chat.categories.list()).items.map((c) => c.id)).toEqual([food]);
    expect((await chat.subcategories.list({ categoryId: food })).items).toEqual([]);
  });

  it("replays a seed with the same Idempotency-Key", async () => {
    const { app, user } = await oneUser();
    const token = await tokenFor(user);
    const body = { selectedNames: ["Salary"] };
    const first = await raw(app, "categories.seedDefaults", body, { token, idempotencyKey: KEY });
    const again = await raw(app, "categories.seedDefaults", body, { token, idempotencyKey: KEY });
    expect((expectOk(first) as { items: unknown[] }).items).toHaveLength(1);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
  });
});
