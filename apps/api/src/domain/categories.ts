/**
 * Categories and subcategories, ported from
 * `packages/backend/convex/domain/categories.ts`. Every function takes the
 * caller's user id and only touches that user's rows; missing and foreign
 * rows are both "not found".
 *
 * Deleting a category or subcategory is allowed while transactions use it, as
 * in Convex. Convex left their ids dangling; here the foreign keys null them
 * (`ON DELETE SET NULL`), so the transactions show as uncategorised.
 */
import { and, asc, eq, sql } from "drizzle-orm";

import { categories, subcategories } from "../db/schema";
import type { Tx } from "../db/tx";
import { invalid, notFound } from "./errors";

export type Category = typeof categories.$inferSelect;
export type Subcategory = typeof subcategories.$inferSelect;
export type CategoryType = Category["type"];

/** What onboarding offers, in this order (it is also the seeded `sortOrder`). */
export const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; type: CategoryType; icon: string; color: string }> = [
  // Income
  { name: "Salary", type: "income", icon: "banknote", color: "#2F5711" },
  { name: "Freelance / Side Income", type: "income", icon: "laptop", color: "#4A7C23" },
  { name: "Investments", type: "income", icon: "trending-up", color: "#1A6B3C" },
  { name: "Gifts", type: "income", icon: "gift", color: "#7C3AED" },
  { name: "Other Income", type: "income", icon: "plus-circle", color: "#6B7280" },
  // Expense
  { name: "Food & Dining", type: "expense", icon: "utensils", color: "#F97316" },
  { name: "Transport", type: "expense", icon: "car", color: "#3B82F6" },
  { name: "Housing & Rent", type: "expense", icon: "home", color: "#8B5CF6" },
  { name: "Utilities", type: "expense", icon: "zap", color: "#EAB308" },
  { name: "Entertainment", type: "expense", icon: "tv", color: "#EC4899" },
  { name: "Health", type: "expense", icon: "heart-pulse", color: "#EF4444" },
  { name: "Shopping", type: "expense", icon: "shopping-bag", color: "#F59E0B" },
  { name: "Education", type: "expense", icon: "graduation-cap", color: "#0EA5E9" },
  { name: "Subscriptions", type: "expense", icon: "repeat", color: "#6366F1" },
  { name: "Other Expenses", type: "expense", icon: "more-horizontal", color: "#6B7280" },
];

/** Convex read at most this many rows per list. */
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

/* Queries ------------------------------------------------------------------ */

/** The user's categories, oldest first. Archived ones only with `includeArchived`. */
export async function listCategories(tx: Tx, userId: string, args: { includeArchived?: boolean } = {}): Promise<Category[]> {
  return await tx
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), args.includeArchived ? undefined : eq(categories.archived, false)))
    .orderBy(asc(categories.createdAt), asc(categories.id))
    .limit(CATEGORY_LIMIT);
}

/** Subcategories of one category, oldest first (empty for someone else's category). */
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

/** Every subcategory of the user, oldest first. */
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

/* Seed --------------------------------------------------------------------- */

/**
 * Create the selected defaults (all of them when `selectedNames` is empty;
 * unknown names are ignored), marked `isDefault`. Does nothing once the user
 * has any category, archived included. Returns what it created.
 */
export async function seedDefaultCategories(tx: Tx, userId: string, args: { selectedNames: string[] }): Promise<Category[]> {
  const [existing] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.userId, userId)).limit(1);
  if (existing) return [];

  const selected = new Set(args.selectedNames);
  const toSeed = selected.size > 0 ? DEFAULT_CATEGORIES.filter((c) => selected.has(c.name)) : DEFAULT_CATEGORIES;
  if (toSeed.length === 0) return [];
  // Rows of one transaction share created_at; the id (UUIDv7, monotonic per session) keeps the insert order.
  return await tx
    .insert(categories)
    .values(toSeed.map((c, i) => ({ userId, ...c, isDefault: true, archived: false, sortOrder: i })))
    .returning();
}

/* Category CRUD ------------------------------------------------------------ */

/** A custom category, placed last within its type. */
export async function createCategory(
  tx: Tx,
  userId: string,
  args: { name: string; type: CategoryType; icon: string; color: string },
): Promise<Category> {
  // As Convex: a missing sortOrder counts as 0, none at all gives 0.
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

/** Changes only the fields given. The type never changes. */
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

/** Hide it from pickers, with its subcategories. Transactions keep it. */
export async function archiveCategory(tx: Tx, userId: string, id: string): Promise<Category> {
  const [category] = await tx.update(categories).set({ archived: true }).where(ownedCategory(userId, id)).returning();
  if (!category) throw notFound("Category");
  await tx
    .update(subcategories)
    .set({ archived: true })
    .where(and(eq(subcategories.categoryId, id), eq(subcategories.userId, userId)));
  return category;
}

/** Bring back the category only: its subcategories stay archived. */
export async function restoreCategory(tx: Tx, userId: string, id: string): Promise<Category> {
  const [category] = await tx.update(categories).set({ archived: false }).where(ownedCategory(userId, id)).returning();
  if (!category) throw notFound("Category");
  return category;
}

/** Delete for good with its subcategories. Transactions that used them lose them (the keys null both columns). */
export async function deleteCategory(tx: Tx, userId: string, id: string): Promise<void> {
  await getCategory(tx, userId, id);
  await tx.delete(subcategories).where(and(eq(subcategories.categoryId, id), eq(subcategories.userId, userId)));
  await tx.delete(categories).where(ownedCategory(userId, id));
}

/* Subcategory CRUD --------------------------------------------------------- */

/** Placed last within its category. The name is trimmed; the parent may be archived. */
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

/** Rename (trimmed, non-blank) and/or archive (`true`) or restore (`false`). */
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

/** Delete for good. Transactions that used it keep their category and lose the subcategory. */
export async function deleteSubcategory(tx: Tx, userId: string, id: string): Promise<void> {
  const [deleted] = await tx.delete(subcategories).where(ownedSubcategory(userId, id)).returning({ id: subcategories.id });
  if (!deleted) throw notFound("Subcategory");
}
