import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createTestUser } from "../../test/app";
import { testDb } from "../../test/db";
import { accounts, categories as categoriesTable, subcategories as subcategoriesTable, transactions } from "../db/schema";
import { readTx, type Tx, withTx } from "../db/tx";
import * as categories from "./categories";
import { DomainError } from "./errors";

const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTx(testDb(), fn);
const read = <T>(fn: (tx: Tx) => Promise<T>) => readTx(testDb(), fn);

async function seedCategory(userId: string, name = "Groceries", type: "income" | "expense" = "expense") {
  return (await tx((t) => categories.createCategory(t, userId, { name, type, icon: "shopping-bag", color: "#fff" }))).id;
}

async function seedSub(userId: string, categoryId: string, name = "Fruit") {
  return (await tx((t) => categories.createSubcategory(t, userId, { categoryId, name }))).id;
}

const categoryRow = async (id: string) =>
  (await testDb().select().from(categoriesTable).where(eq(categoriesTable.id, id)))[0];
const subcategoryRow = async (id: string) =>
  (await testDb().select().from(subcategoriesTable).where(eq(subcategoriesTable.id, id)))[0];

describe("domain/categories", () => {
  it("exposes the 15 default categories, Salary first", () => {
    expect(categories.DEFAULT_CATEGORIES).toHaveLength(15);
    expect(categories.DEFAULT_CATEGORIES[0]).toMatchObject({ name: "Salary", type: "income" });
  });

  describe("listCategories", () => {
    it("is empty for a new user", async () => {
      const user = await createTestUser();
      expect(await read((t) => categories.listCategories(t, user))).toEqual([]);
    });

    it("lists in creation order, archived ones only with includeArchived", async () => {
      const user = await createTestUser();
      const a = await seedCategory(user, "A");
      const b = await seedCategory(user, "B", "income");
      await tx((t) => categories.archiveCategory(t, user, a));
      expect((await read((t) => categories.listCategories(t, user))).map((c) => c.id)).toEqual([b]);
      const all = await read((t) => categories.listCategories(t, user, { includeArchived: true }));
      expect(all.map((c) => c.id)).toEqual([a, b]);
      expect(all[0]).toMatchObject({ name: "A", archived: true });
    });
  });

  describe("seedDefaultCategories", () => {
    it("seeds the selected defaults, ignoring unknown names, marked default and ordered", async () => {
      const user = await createTestUser();
      const created = await tx((t) =>
        categories.seedDefaultCategories(t, user, { selectedNames: ["Salary", "Food & Dining", "Transport", "Nope"] }),
      );
      expect(created.map((c) => [c.name, c.type, c.isDefault, c.sortOrder])).toEqual([
        ["Salary", "income", true, 0],
        ["Food & Dining", "expense", true, 1],
        ["Transport", "expense", true, 2],
      ]);
      expect(created[0]).toMatchObject({ icon: "banknote", color: "#2F5711", archived: false });
      expect((await read((t) => categories.listCategories(t, user))).map((c) => c.id)).toEqual(created.map((c) => c.id));
    });

    it("seeds all defaults when selectedNames is empty", async () => {
      const user = await createTestUser();
      await tx((t) => categories.seedDefaultCategories(t, user, { selectedNames: [] }));
      const names = (await read((t) => categories.listCategories(t, user))).map((c) => c.name);
      expect(names).toEqual(categories.DEFAULT_CATEGORIES.map((c) => c.name));
    });

    it("does nothing once the user has any category, archived included, per user", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      await tx((t) => categories.seedDefaultCategories(t, alice, { selectedNames: ["Salary"] }));
      expect(await tx((t) => categories.seedDefaultCategories(t, alice, { selectedNames: ["Food & Dining"] }))).toEqual([]);
      expect((await read((t) => categories.listCategories(t, alice))).map((c) => c.name)).toEqual(["Salary"]);

      const archived = await seedCategory(bob, "Mine");
      await tx((t) => categories.archiveCategory(t, bob, archived));
      expect(await tx((t) => categories.seedDefaultCategories(t, bob, { selectedNames: [] }))).toEqual([]);
    });

    it("seeds once when two requests race", async () => {
      const user = await createTestUser();
      await Promise.all([
        tx((t) => categories.seedDefaultCategories(t, user, { selectedNames: [] })),
        tx((t) => categories.seedDefaultCategories(t, user, { selectedNames: [] })),
      ]);
      expect(await read((t) => categories.listCategories(t, user))).toHaveLength(15);
    });
  });

  describe("createCategory", () => {
    it("creates a custom category, not default, not archived", async () => {
      const user = await createTestUser();
      const category = await tx((t) =>
        categories.createCategory(t, user, { name: "Pets", type: "expense", icon: "paw-print", color: "#8B4513" }),
      );
      expect(category).toMatchObject({
        userId: user,
        name: "Pets",
        type: "expense",
        icon: "paw-print",
        color: "#8B4513",
        isDefault: false,
        archived: false,
        sortOrder: 0,
      });
    });

    it("places it last within its type", async () => {
      const user = await createTestUser();
      await tx((t) => categories.seedDefaultCategories(t, user, { selectedNames: ["Salary", "Transport"] }));
      // Seeded sortOrders are 0 (Salary, income) and 1 (Transport, expense).
      const a = await seedCategory(user, "A");
      const b = await seedCategory(user, "B");
      const c = await seedCategory(user, "C", "income");
      expect((await categoryRow(a))?.sortOrder).toBe(2);
      expect((await categoryRow(b))?.sortOrder).toBe(3);
      expect((await categoryRow(c))?.sortOrder).toBe(1);
    });

    it("counts a missing sortOrder as 0, as Convex did", async () => {
      const user = await createTestUser();
      await testDb().insert(categoriesTable).values({ userId: user, name: "Legacy", type: "expense" });
      expect((await categoryRow(await seedCategory(user)))?.sortOrder).toBe(1);
    });
  });

  it("updates only the given fields", async () => {
    const user = await createTestUser();
    const id = await seedCategory(user, "Old");
    const updated = await tx((t) => categories.updateCategory(t, user, id, { name: "New", color: "#000", icon: undefined }));
    expect(updated).toMatchObject({ name: "New", color: "#000", icon: "shopping-bag", type: "expense" });
    expect(await tx((t) => categories.updateCategory(t, user, id, {}))).toMatchObject({ name: "New" });
  });

  it("archives a category with its subcategories; restore brings back the category only", async () => {
    const user = await createTestUser();
    const id = await seedCategory(user);
    const fruit = await seedSub(user, id, "Fruit");
    const veg = await seedSub(user, id, "Veg");
    const other = await seedSub(user, await seedCategory(user, "Other"));

    expect(await tx((t) => categories.archiveCategory(t, user, id))).toMatchObject({ archived: true });
    expect(await subcategoryRow(fruit)).toMatchObject({ archived: true });
    expect(await subcategoryRow(veg)).toMatchObject({ archived: true });
    expect(await subcategoryRow(other)).toMatchObject({ archived: false });

    expect(await tx((t) => categories.restoreCategory(t, user, id))).toMatchObject({ archived: false });
    expect(await subcategoryRow(fruit)).toMatchObject({ archived: true });
  });

  describe("deleteCategory", () => {
    it("deletes the category and its subcategories", async () => {
      const user = await createTestUser();
      const id = await seedCategory(user);
      const sub = await seedSub(user, id);
      const kept = await seedSub(user, await seedCategory(user, "Other"));
      await tx((t) => categories.deleteCategory(t, user, id));
      expect(await categoryRow(id)).toBeUndefined();
      expect(await subcategoryRow(sub)).toBeUndefined();
      expect(await subcategoryRow(kept)).toBeDefined();
    });

    it("keeps transactions that used it, without the category and subcategory", async () => {
      const user = await createTestUser();
      const id = await seedCategory(user);
      const sub = await seedSub(user, id);
      const other = await seedCategory(user, "Other");
      const [account] = await testDb()
        .insert(accounts)
        .values({ userId: user, name: "a", type: "bank", balance: 0, currency: "USD" })
        .returning();
      const base = { userId: user, type: "expense" as const, amount: 100, accountId: account!.id, date: "2026-01-01" };
      const [used, untouched] = await testDb()
        .insert(transactions)
        .values([
          { ...base, categoryId: id, subcategoryId: sub },
          { ...base, categoryId: other },
        ])
        .returning();

      await tx((t) => categories.deleteCategory(t, user, id));
      const rows = await testDb().select().from(transactions);
      expect(rows.find((r) => r.id === used!.id)).toMatchObject({ userId: user, categoryId: null, subcategoryId: null, amount: 100 });
      expect(rows.find((r) => r.id === untouched!.id)).toMatchObject({ categoryId: other });
    });
  });

  describe("subcategories", () => {
    it("creates with a trimmed name and incrementing sortOrder per category", async () => {
      const user = await createTestUser();
      const categoryId = await seedCategory(user);
      const first = await tx((t) => categories.createSubcategory(t, user, { categoryId, name: "  Fruit  " }));
      const second = await tx((t) => categories.createSubcategory(t, user, { categoryId, name: "Veg" }));
      const elsewhere = await seedSub(user, await seedCategory(user, "Other"));
      expect(first).toMatchObject({ userId: user, categoryId, name: "Fruit", archived: false, sortOrder: 0 });
      expect(second).toMatchObject({ sortOrder: 1 });
      expect((await subcategoryRow(elsewhere))?.sortOrder).toBe(0);
    });

    it("can be created under an archived category", async () => {
      const user = await createTestUser();
      const categoryId = await seedCategory(user);
      await tx((t) => categories.archiveCategory(t, user, categoryId));
      expect(await tx((t) => categories.createSubcategory(t, user, { categoryId, name: "Late" }))).toMatchObject({ archived: false });
    });

    it("rejects blank names on create and update", async () => {
      const user = await createTestUser();
      const categoryId = await seedCategory(user);
      const id = await seedSub(user, categoryId);
      for (const op of [
        (t: Tx) => categories.createSubcategory(t, user, { categoryId, name: "   " }),
        (t: Tx) => categories.updateSubcategory(t, user, id, { name: "   " }),
      ]) {
        const error = await tx(op).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: "validation_failed", message: "Subcategory name is required" });
      }
      expect(await subcategoryRow(id)).toMatchObject({ name: "Fruit" });
    });

    it("renames (trimmed), archives, restores and deletes", async () => {
      const user = await createTestUser();
      const categoryId = await seedCategory(user);
      const id = await seedSub(user, categoryId);
      const keep = await seedSub(user, categoryId, "Veg");

      expect(await tx((t) => categories.updateSubcategory(t, user, id, { name: "  Weekly groceries  " }))).toMatchObject({
        name: "Weekly groceries",
      });
      await tx((t) => categories.updateSubcategory(t, user, id, { archived: true }));
      expect((await read((t) => categories.listSubcategories(t, user, { categoryId }))).map((s) => s.id)).toEqual([keep]);
      expect(await read((t) => categories.listSubcategories(t, user, { categoryId, includeArchived: true }))).toHaveLength(2);
      expect(await read((t) => categories.listAllSubcategories(t, user))).toHaveLength(1);
      expect(await read((t) => categories.listAllSubcategories(t, user, { includeArchived: true }))).toHaveLength(2);

      await tx((t) => categories.updateSubcategory(t, user, id, { archived: false }));
      expect(await read((t) => categories.listSubcategories(t, user, { categoryId }))).toHaveLength(2);
      await tx((t) => categories.deleteSubcategory(t, user, id));
      expect(await subcategoryRow(id)).toBeUndefined();
      expect(await categoryRow(categoryId)).toBeDefined();
    });

    it("lists every category's subcategories in creation order", async () => {
      const user = await createTestUser();
      const food = await seedCategory(user, "Food");
      const transport = await seedCategory(user, "Transport");
      const groceries = await seedSub(user, food, "Groceries");
      const gas = await seedSub(user, transport, "Gas");
      const fruit = await seedSub(user, food, "Fruit");
      expect((await read((t) => categories.listAllSubcategories(t, user))).map((s) => s.id)).toEqual([groceries, gas, fruit]);
      expect((await read((t) => categories.listSubcategories(t, user, { categoryId: food }))).map((s) => s.id)).toEqual([
        groceries,
        fruit,
      ]);
    });

    it("deleting one keeps its transactions and their category", async () => {
      const user = await createTestUser();
      const categoryId = await seedCategory(user);
      const id = await seedSub(user, categoryId);
      const [account] = await testDb()
        .insert(accounts)
        .values({ userId: user, name: "a", type: "bank", balance: 0, currency: "USD" })
        .returning();
      await testDb()
        .insert(transactions)
        .values({ userId: user, type: "expense", amount: 1, accountId: account!.id, date: "2026-01-01", categoryId, subcategoryId: id });
      await tx((t) => categories.deleteSubcategory(t, user, id));
      expect((await testDb().select().from(transactions))[0]).toMatchObject({ categoryId, subcategoryId: null });
    });
  });

  describe("cross-user ownership", () => {
    it("rejects category operations from another user", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const id = await seedCategory(alice);
      const ops: Array<(t: Tx) => Promise<unknown>> = [
        (t) => categories.getCategory(t, bob, id),
        (t) => categories.updateCategory(t, bob, id, { name: "x" }),
        (t) => categories.updateCategory(t, bob, id, {}),
        (t) => categories.archiveCategory(t, bob, id),
        (t) => categories.restoreCategory(t, bob, id),
        (t) => categories.deleteCategory(t, bob, id),
      ];
      for (const op of ops) await expect(tx(op)).rejects.toThrow("Category not found");
      await expect(tx((t) => categories.createSubcategory(t, bob, { categoryId: id, name: "x" }))).rejects.toThrow(
        "Parent category not found",
      );
      expect(await categoryRow(id)).toMatchObject({ userId: alice, name: "Groceries", archived: false });
    });

    it("rejects subcategory operations from another user", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const id = await seedSub(alice, await seedCategory(alice));
      const ops: Array<(t: Tx) => Promise<unknown>> = [
        (t) => categories.getSubcategory(t, bob, id),
        (t) => categories.updateSubcategory(t, bob, id, { name: "x" }),
        (t) => categories.updateSubcategory(t, bob, id, { archived: true }),
        (t) => categories.deleteSubcategory(t, bob, id),
      ];
      for (const op of ops) await expect(tx(op)).rejects.toThrow("Subcategory not found");
      expect(await subcategoryRow(id)).toMatchObject({ userId: alice, name: "Fruit", archived: false });
    });

    it("does not leak or cascade into another user's data", async () => {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const categoryId = await seedCategory(alice);
      const subId = await seedSub(alice, categoryId);
      await seedCategory(bob, "Bob's");

      expect((await read((t) => categories.listCategories(t, bob))).map((c) => c.name)).toEqual(["Bob's"]);
      expect(await read((t) => categories.listSubcategories(t, bob, { categoryId }))).toEqual([]);
      expect(await read((t) => categories.listAllSubcategories(t, bob, { includeArchived: true }))).toEqual([]);
      expect(await subcategoryRow(subId)).toMatchObject({ userId: alice, archived: false });
    });
  });
});
