import { DEFAULT_CATEGORIES } from "@mpf/finance-contract";
import { and, asc, eq, sql } from "drizzle-orm";

import { categories, subcategories } from "../db/schema";
import type { Tx } from "../db/tx";
import { invalid, notFound } from "./errors";

export type Category = typeof categories.$inferSelect;
export type Subcategory = typeof subcategories.$inferSelect;
export type CategoryType = Category["type"];

export { DEFAULT_CATEGORIES };

const CATEGORY_LIMIT = 200;
const SUBCATEGORY_PER_CATEGORY_LIMIT = 100;
const SUBCATEGORY_LIMIT = 500;

const ownedCategory = (userId: string, id: string) => and(eq(categories.id, id), eq(categories.userId, userId));
const ownedSubcategory = (userId: string, id: string) => and(eq(subcategories.id, id), eq(subcategories.userId, userId));

function subcategoryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw invalid("name", "Subcategory name is required");
  return trimmed;
}

export async function listCategories(tx: Tx, userId: string, args: { includeArchived?: boolean } = {}): Promise<Category[]> {
  return await tx
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), args.includeArchived ? undefined : eq(categories.archived, false)))
    .orderBy(asc(categories.createdAt), asc(categories.id))
    .limit(CATEGORY_LIMIT);
}

export async function listSubcategories(
  tx: Tx,
  userId: string,
  args: { categoryId: string; includeArchived?: boolean },
): Promise<Subcategory[]> {
  return await tx
    .select()
    .from(subcategories)
    .where(
      and(
        eq(subcategories.categoryId, args.categoryId),
        eq(subcategories.userId, userId),
        args.includeArchived ? undefined : eq(subcategories.archived, false),
      ),
    )
    .orderBy(asc(subcategories.createdAt), asc(subcategories.id))
    .limit(SUBCATEGORY_PER_CATEGORY_LIMIT);
}

export async function listAllSubcategories(
  tx: Tx,
  userId: string,
  args: { includeArchived?: boolean } = {},
): Promise<Subcategory[]> {
  return await tx
    .select()
    .from(subcategories)
    .where(and(eq(subcategories.userId, userId), args.includeArchived ? undefined : eq(subcategories.archived, false)))
    .orderBy(asc(subcategories.createdAt), asc(subcategories.id))
    .limit(SUBCATEGORY_LIMIT);
}

export async function getCategory(tx: Tx, userId: string, id: string, what = "Category"): Promise<Category> {
  const [category] = await tx.select().from(categories).where(ownedCategory(userId, id)).limit(1);
  if (!category) throw notFound(what);
  return category;
}

export async function getSubcategory(tx: Tx, userId: string, id: string): Promise<Subcategory> {
  const [subcategory] = await tx.select().from(subcategories).where(ownedSubcategory(userId, id)).limit(1);
  if (!subcategory) throw notFound("Subcategory");
  return subcategory;
}

export async function seedDefaultCategories(tx: Tx, userId: string, args: { selectedNames: string[] }): Promise<Category[]> {
  const [existing] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.userId, userId)).limit(1);
  if (existing) return [];

  const selected = new Set(args.selectedNames);
  const toSeed = selected.size > 0 ? DEFAULT_CATEGORIES.filter((c) => selected.has(c.name)) : DEFAULT_CATEGORIES;
  if (toSeed.length === 0) return [];
  return await tx
    .insert(categories)
    .values(toSeed.map((c, i) => ({ userId, ...c, isDefault: true, archived: false, sortOrder: i })))
    .returning();
}

export async function createCategory(
  tx: Tx,
  userId: string,
  args: { name: string; type: CategoryType; icon: string; color: string },
): Promise<Category> {
  const [{ next } = { next: 0 }] = await tx
    .select({ next: sql<number>`coalesce(max(coalesce(${categories.sortOrder}, 0)), -1)::int + 1` })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.type, args.type)));
  const [category] = await tx
    .insert(categories)
    .values({ userId, ...args, isDefault: false, archived: false, sortOrder: next })
    .returning();
  return category!;
}

export async function updateCategory(
  tx: Tx,
  userId: string,
  id: string,
  fields: { name?: string; icon?: string; color?: string },
): Promise<Category> {
  const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return await getCategory(tx, userId, id);
  const [category] = await tx.update(categories).set(patch).where(ownedCategory(userId, id)).returning();
  if (!category) throw notFound("Category");
  return category;
}

export async function archiveCategory(tx: Tx, userId: string, id: string): Promise<Category> {
  const [category] = await tx.update(categories).set({ archived: true }).where(ownedCategory(userId, id)).returning();
  if (!category) throw notFound("Category");
  await tx
    .update(subcategories)
    .set({ archived: true })
    .where(and(eq(subcategories.categoryId, id), eq(subcategories.userId, userId)));
  return category;
}

export async function restoreCategory(tx: Tx, userId: string, id: string): Promise<Category> {
  const [category] = await tx.update(categories).set({ archived: false }).where(ownedCategory(userId, id)).returning();
  if (!category) throw notFound("Category");
  return category;
}

export async function deleteCategory(tx: Tx, userId: string, id: string): Promise<void> {
  const [deleted] = await tx.delete(categories).where(ownedCategory(userId, id)).returning({ id: categories.id });
  if (!deleted) throw notFound("Category");
  await tx.delete(subcategories).where(and(eq(subcategories.categoryId, id), eq(subcategories.userId, userId)));
}

export async function createSubcategory(tx: Tx, userId: string, args: { categoryId: string; name: string }): Promise<Subcategory> {
  const name = subcategoryName(args.name);
  await getCategory(tx, userId, args.categoryId, "Parent category");
  const [{ next } = { next: 0 }] = await tx
    .select({ next: sql<number>`coalesce(max(${subcategories.sortOrder}), -1)::int + 1` })
    .from(subcategories)
    .where(and(eq(subcategories.categoryId, args.categoryId), eq(subcategories.userId, userId)));
  const [subcategory] = await tx
    .insert(subcategories)
    .values({ userId, categoryId: args.categoryId, name, archived: false, sortOrder: next })
    .returning();
  return subcategory!;
}

export async function updateSubcategory(
  tx: Tx,
  userId: string,
  id: string,
  fields: { name?: string; archived?: boolean },
): Promise<Subcategory> {
  const patch: Partial<Pick<Subcategory, "name" | "archived">> = {};
  if (fields.name !== undefined) patch.name = subcategoryName(fields.name);
  if (fields.archived !== undefined) patch.archived = fields.archived;
  if (Object.keys(patch).length === 0) return await getSubcategory(tx, userId, id);
  const [subcategory] = await tx.update(subcategories).set(patch).where(ownedSubcategory(userId, id)).returning();
  if (!subcategory) throw notFound("Subcategory");
  return subcategory;
}

export async function deleteSubcategory(tx: Tx, userId: string, id: string): Promise<void> {
  const [deleted] = await tx.delete(subcategories).where(ownedSubcategory(userId, id)).returning({ id: subcategories.id });
  if (!deleted) throw notFound("Subcategory");
}
