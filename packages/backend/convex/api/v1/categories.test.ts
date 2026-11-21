import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import {
  clientFor,
  expectApiError,
  expectConforms,
  linkedChat,
  raw,
  seedCategory,
  seedUser,
  setupApi,
  tokenFor,
  twoUsers,
  type T,
} from "./test.helpers";

const seedSub = (t: T, userId: string, categoryId: string, extra: { archived?: boolean; name?: string } = {}) =>
  t.run((ctx) =>
    ctx.db.insert("subcategories", {
      userId,
      categoryId: ctx.db.normalizeId("categories", categoryId)!,
      name: extra.name ?? "Groceries",
      archived: extra.archived ?? false,
      sortOrder: 0,
    }),
  );

describe("api/v1 categories and subcategories", () => {
  it("lists categories, hiding archived ones unless asked", async () => {
    const t = setupApi();
    const { alice, asAlice } = await twoUsers(t);
    const food = await seedCategory(t, alice);
    const old = await seedCategory(t, alice, { name: "Old" });
    await t.run((ctx) => ctx.db.patch(old, { archived: true }));
    const token = await tokenFor(alice);

    const list = expectConforms(routes.categories.list, await raw(t, "GET", "/categories", { token }));
    expect(list).toEqual({ items: [{ id: food, name: "Food", type: "expense", isDefault: false }] });
    expect((await asAlice.categories.list({ includeArchived: true })).items.map((c) => c.id)).toEqual([food, old]);
  });

  it("lists subcategories for one category or all of them", async () => {
    const t = setupApi();
    const { alice, asAlice } = await twoUsers(t);
    const food = await seedCategory(t, alice);
    const fun = await seedCategory(t, alice, { name: "Fun" });
    const groceries = await seedSub(t, alice, food);
    const archived = await seedSub(t, alice, food, { archived: true, name: "Old" });
    const games = await seedSub(t, alice, fun, { name: "Games" });
    const token = await tokenFor(alice);

    const one = expectConforms(routes.subcategories.list, await raw(t, "GET", `/subcategories?categoryId=${food}`, { token }));
    expect(one).toEqual({ items: [{ id: groceries, categoryId: food, name: "Groceries", archived: false, sortOrder: 0 }] });
    expect((await asAlice.subcategories.list({ categoryId: food, includeArchived: true })).items.map((s) => s.id)).toEqual([groceries, archived]);
    expect((await asAlice.subcategories.list()).items.map((s) => s.id)).toEqual([groceries, games]);
  });

  it("validates ids and isolates users", async () => {
    const t = setupApi();
    const { alice, asAlice, asBob } = await twoUsers(t);
    const food = await seedCategory(t, alice);
    await seedSub(t, alice, food);
    await expectApiError(asAlice.subcategories.list({ categoryId: "nope" }), "validation_failed", 400);
    await expectApiError(asBob.subcategories.list({ categoryId: food }), "not_found", 404);
    expect((await asBob.categories.list({ includeArchived: true })).items).toEqual([]);
    expect((await asBob.subcategories.list({ includeArchived: true })).items).toEqual([]);
  });

  it("lists the defaults and seeds them once, as onboarding does", async () => {
    const t = setupApi();
    const client = clientFor(t, await tokenFor(await seedUser(t)));
    const { items: defaults } = await client.categories.defaults();
    expect(defaults).toHaveLength(15);
    expect(defaults[0]).toEqual({ name: "Salary", type: "income", icon: "banknote", color: "#2F5711" });

    const { items } = await client.categories.seedDefaults({ selectedNames: ["Salary", "Transport", "Nope"] });
    expect(items.map((c) => [c.name, c.isDefault, c.sortOrder])).toEqual([
      ["Salary", true, 0],
      ["Transport", true, 1],
    ]);
    expect(await client.categories.seedDefaults({ selectedNames: [] })).toEqual({ items: [] });
    expect((await client.categories.list()).items).toHaveLength(2);
  });

  it("creates, updates, archives, restores and deletes categories and subcategories", async () => {
    const t = setupApi();
    const client = clientFor(t, await tokenFor(await seedUser(t)));

    const { category } = await client.categories.create({ name: " Pets ", type: "expense", icon: "paw-print", color: "#8B4513" });
    expect(category).toMatchObject({ name: "Pets", type: "expense", icon: "paw-print", color: "#8B4513", isDefault: false, sortOrder: 0 });
    expect((await client.categories.update({ id: category.id, name: "Animals" })).category).toMatchObject({ name: "Animals", icon: "paw-print" });

    const { subcategory } = await client.subcategories.create({ categoryId: category.id, name: " Food " });
    expect(subcategory).toEqual({ id: subcategory.id, categoryId: category.id, name: "Food", archived: false, sortOrder: 0 });
    expect((await client.subcategories.update({ id: subcategory.id, name: "Vet" })).subcategory.name).toBe("Vet");
    expect((await client.subcategories.archive({ id: subcategory.id })).subcategory.archived).toBe(true);
    expect((await client.subcategories.restore({ id: subcategory.id })).subcategory.archived).toBe(false);

    expect((await client.categories.archive({ id: category.id })).category.archived).toBe(true);
    expect((await client.subcategories.list({ includeArchived: true })).items[0]?.archived).toBe(true);
    expect((await client.categories.restore({ id: category.id })).category.archived).toBe(false);

    expect(await client.subcategories.delete({ id: subcategory.id })).toEqual({ id: subcategory.id });
    expect(await client.categories.delete({ id: category.id })).toEqual({ id: category.id });
    expect((await client.categories.list({ includeArchived: true })).items).toEqual([]);
  });

  it("refuses another user's rows and chat tokens", async () => {
    const t = setupApi();
    const { alice, asBob } = await twoUsers(t);
    const food = await seedCategory(t, alice);
    const sub = await seedSub(t, alice, food);
    await expectApiError(asBob.categories.update({ id: food, name: "x" }), "not_found", 404);
    await expectApiError(asBob.categories.archive({ id: food }), "not_found", 404);
    await expectApiError(asBob.categories.delete({ id: food }), "not_found", 404);
    const parent = await expectApiError(asBob.subcategories.create({ categoryId: food, name: "x" }), "not_found", 404);
    expect(parent.message).toBe("Parent category not found");
    await expectApiError(asBob.subcategories.delete({ id: sub }), "not_found", 404);
    expect(await t.run((ctx) => ctx.db.get(food))).toMatchObject({ name: "Food" });

    const chat = await linkedChat(t);
    await expectApiError(chat.finance.categories.defaults(), "forbidden", 403);
    await expectApiError(chat.finance.categories.create({ name: "x", type: "expense", icon: "a", color: "#000" }), "forbidden", 403);
    await expectApiError(chat.finance.subcategories.delete({ id: sub }), "forbidden", 403);
  });
});
