import { routes } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { expectApiError, expectConforms, raw, seedCategory, setupApi, tokenFor, twoUsers, type T } from "./test.helpers";

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
});
