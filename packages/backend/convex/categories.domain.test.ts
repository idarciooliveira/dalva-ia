import { describe, expect, it } from "vitest";
import * as categories from "./domain/categories";
import { setupTest } from "./test.setup";

const ALICE = "alice-domain";
const BOB = "bob-domain";

type T = ReturnType<typeof setupTest>;

async function seedCategory(t: T, userId: string, name = "Groceries") {
  return await t.run((ctx) =>
    categories.createCategory(ctx, userId, {
      name,
      type: "expense",
      icon: "shopping-bag",
      color: "#fff",
    }),
  );
}

async function seedSub(t: T, userId: string, categoryId: any, name = "Fruit") {
  return await t.run((ctx) =>
    categories.createSubcategory(ctx, userId, { categoryId, name }),
  );
}

describe("domain/categories", () => {
  it("exposes the default category list", () => {
    expect(categories.DEFAULT_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("seeds defaults once per user, honoring selectedNames", async () => {
    const t = setupTest();
    await t.run((ctx) =>
      categories.seedDefaultCategories(ctx, ALICE, {
        selectedNames: ["Salary", "Transport"],
      }),
    );
    // idempotent
    await t.run((ctx) =>
      categories.seedDefaultCategories(ctx, ALICE, { selectedNames: [] }),
    );
    const mine = await t.run((ctx) => categories.listCategories(ctx, ALICE, {}));
    expect(mine.map((c) => c.name)).toEqual(["Salary", "Transport"]);
    expect(mine.map((c) => c.sortOrder)).toEqual([0, 1]);

    await t.run((ctx) =>
      categories.seedDefaultCategories(ctx, BOB, { selectedNames: [] }),
    );
    const bobs = await t.run((ctx) => categories.listCategories(ctx, BOB, {}));
    expect(bobs).toHaveLength(categories.DEFAULT_CATEGORIES.length);
  });

  it("creates categories with incrementing sortOrder per type", async () => {
    const t = setupTest();
    const a = await seedCategory(t, ALICE, "A");
    const b = await seedCategory(t, ALICE, "B");
    const docs = await t.run(async (ctx) => [await ctx.db.get(a), await ctx.db.get(b)]);
    expect(docs[0]).toMatchObject({ userId: ALICE, sortOrder: 0, isDefault: false });
    expect(docs[1]).toMatchObject({ sortOrder: 1 });
  });

  it("updates, archives (cascading to subcategories), restores and deletes", async () => {
    const t = setupTest();
    const id = await seedCategory(t, ALICE);
    const subId = await seedSub(t, ALICE, id);

    await t.run((ctx) =>
      categories.updateCategory(ctx, ALICE, { id, name: "Food", color: "#000" }),
    );
    await t.run((ctx) => categories.archiveCategory(ctx, ALICE, { id }));

    const state = await t.run(async (ctx) => ({
      cat: await ctx.db.get(id),
      sub: await ctx.db.get(subId),
    }));
    expect(state.cat).toMatchObject({ name: "Food", color: "#000", archived: true });
    expect(state.sub).toMatchObject({ archived: true });

    expect(await t.run((ctx) => categories.listCategories(ctx, ALICE, {}))).toEqual([]);
    expect(
      await t.run((ctx) => categories.listCategories(ctx, ALICE, { includeArchived: true })),
    ).toHaveLength(1);

    await t.run((ctx) => categories.restoreCategory(ctx, ALICE, { id }));
    await t.run((ctx) => categories.deleteCategory(ctx, ALICE, { id }));
    const after = await t.run(async (ctx) => ({
      cat: await ctx.db.get(id),
      sub: await ctx.db.get(subId),
    }));
    expect(after).toEqual({ cat: null, sub: null });
  });

  it("manages subcategories", async () => {
    const t = setupTest();
    const categoryId = await seedCategory(t, ALICE);
    const first = await seedSub(t, ALICE, categoryId, "  Fruit  ");
    const second = await seedSub(t, ALICE, categoryId, "Veg");
    const docs = await t.run(async (ctx) => [await ctx.db.get(first), await ctx.db.get(second)]);
    expect(docs[0]).toMatchObject({ name: "Fruit", sortOrder: 0 });
    expect(docs[1]).toMatchObject({ sortOrder: 1 });

    await expect(
      t.run((ctx) => categories.createSubcategory(ctx, ALICE, { categoryId, name: "   " })),
    ).rejects.toThrow("Subcategory name is required");

    await t.run((ctx) => categories.updateSubcategory(ctx, ALICE, { id: first, name: "Apples" }));
    await t.run((ctx) => categories.archiveSubcategory(ctx, ALICE, { id: first }));
    expect(
      await t.run((ctx) => categories.listSubcategories(ctx, ALICE, { categoryId })),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) =>
        categories.listAllSubcategories(ctx, ALICE, { includeArchived: true }),
      ),
    ).toHaveLength(2);
    await t.run((ctx) => categories.restoreSubcategory(ctx, ALICE, { id: first }));
    await t.run((ctx) => categories.deleteSubcategory(ctx, ALICE, { id: first }));
    expect(await t.run((ctx) => ctx.db.get(first))).toBeNull();
  });

  describe("cross-user ownership", () => {
    it("rejects category operations from another user", async () => {
      const t = setupTest();
      const id = await seedCategory(t, ALICE);
      const ops = [
        (ctx: any) => categories.updateCategory(ctx, BOB, { id, name: "x" }),
        (ctx: any) => categories.archiveCategory(ctx, BOB, { id }),
        (ctx: any) => categories.restoreCategory(ctx, BOB, { id }),
        (ctx: any) => categories.deleteCategory(ctx, BOB, { id }),
      ];
      for (const op of ops) {
        await expect(t.run(op)).rejects.toThrow("Category not found");
      }
      await expect(
        t.run((ctx) => categories.createSubcategory(ctx, BOB, { categoryId: id, name: "x" })),
      ).rejects.toThrow("Parent category not found");
      expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ userId: ALICE, name: "Groceries" });
    });

    it("rejects subcategory operations from another user", async () => {
      const t = setupTest();
      const categoryId = await seedCategory(t, ALICE);
      const id = await seedSub(t, ALICE, categoryId);
      const ops = [
        (ctx: any) => categories.updateSubcategory(ctx, BOB, { id, name: "x" }),
        (ctx: any) => categories.archiveSubcategory(ctx, BOB, { id }),
        (ctx: any) => categories.restoreSubcategory(ctx, BOB, { id }),
        (ctx: any) => categories.deleteSubcategory(ctx, BOB, { id }),
      ];
      for (const op of ops) {
        await expect(t.run(op)).rejects.toThrow("Subcategory not found");
      }
    });

    it("does not leak or cascade into another user's data", async () => {
      const t = setupTest();
      const categoryId = await seedCategory(t, ALICE);
      const subId = await seedSub(t, ALICE, categoryId);

      expect(await t.run((ctx) => categories.listCategories(ctx, BOB, {}))).toEqual([]);
      expect(await t.run((ctx) => categories.listSubcategories(ctx, BOB, { categoryId }))).toEqual([]);
      expect(await t.run((ctx) => categories.listAllSubcategories(ctx, BOB, {}))).toEqual([]);
      expect(await t.run((ctx) => ctx.db.get(subId))).toMatchObject({ userId: ALICE, archived: false });
    });
  });
});
