import { routes } from "@mpf/finance-contract";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import * as categories from "../../domain/categories";
import { apiMutation, apiQuery } from "./define";
import { categoryDto, requireOwned, subcategoryDto } from "./shared";

export const list = apiQuery(routes.categories.list, async (ctx, userId, input) => {
  const docs = await categories.listCategories(ctx, userId, { includeArchived: input.includeArchived });
  return { items: docs.map(categoryDto) };
});

export const listSubcategories = apiQuery(routes.subcategories.list, async (ctx, userId, input) => {
  if (!input.categoryId) {
    const docs = await categories.listAllSubcategories(ctx, userId, { includeArchived: input.includeArchived });
    return { items: docs.map(subcategoryDto) };
  }
  const category = await requireOwned(ctx, userId, "categories", input.categoryId, "categoryId", "Category");
  const docs = await categories.listSubcategories(ctx, userId, {
    categoryId: category._id,
    includeArchived: input.includeArchived,
  });
  return { items: docs.map(subcategoryDto) };
});

/* Web-only management ------------------------------------------------------ */

const getCategory = async (ctx: MutationCtx, id: Id<"categories">) => categoryDto((await ctx.db.get(id))!);
const getSubcategory = async (ctx: MutationCtx, id: Id<"subcategories">) => subcategoryDto((await ctx.db.get(id))!);

export const defaults = apiQuery(routes.categories.defaults, async () => ({ items: categories.DEFAULT_CATEGORIES }));

export const seedDefaults = apiMutation(routes.categories.seedDefaults, async (ctx, userId, input) => {
  const before = await categories.listCategories(ctx, userId, { includeArchived: true });
  if (before.length > 0) return { items: [] };
  await categories.seedDefaultCategories(ctx, userId, { selectedNames: input.selectedNames });
  const created = await categories.listCategories(ctx, userId, { includeArchived: true });
  return { items: created.map(categoryDto) };
});

export const create = apiMutation(routes.categories.create, async (ctx, userId, input) => {
  const id = await categories.createCategory(ctx, userId, input);
  return { category: await getCategory(ctx, id) };
});

export const update = apiMutation(routes.categories.update, async (ctx, userId, input) => {
  const { id, ...fields } = input;
  const category = await requireOwned(ctx, userId, "categories", id, "id", "Category");
  await categories.updateCategory(ctx, userId, { id: category._id, ...fields });
  return { category: await getCategory(ctx, category._id) };
});

export const archive = apiMutation(routes.categories.archive, async (ctx, userId, input) => {
  const category = await requireOwned(ctx, userId, "categories", input.id, "id", "Category");
  await categories.archiveCategory(ctx, userId, { id: category._id });
  return { category: await getCategory(ctx, category._id) };
});

export const restore = apiMutation(routes.categories.restore, async (ctx, userId, input) => {
  const category = await requireOwned(ctx, userId, "categories", input.id, "id", "Category");
  await categories.restoreCategory(ctx, userId, { id: category._id });
  return { category: await getCategory(ctx, category._id) };
});

export const remove = apiMutation(routes.categories.delete, async (ctx, userId, input) => {
  const category = await requireOwned(ctx, userId, "categories", input.id, "id", "Category");
  await categories.deleteCategory(ctx, userId, { id: category._id });
  return { id: category._id as string };
});

export const createSubcategory = apiMutation(routes.subcategories.create, async (ctx, userId, input) => {
  const category = await requireOwned(ctx, userId, "categories", input.categoryId, "categoryId", "Parent category");
  const id = await categories.createSubcategory(ctx, userId, { categoryId: category._id, name: input.name });
  return { subcategory: await getSubcategory(ctx, id) };
});

export const updateSubcategory = apiMutation(routes.subcategories.update, async (ctx, userId, input) => {
  const sub = await requireOwned(ctx, userId, "subcategories", input.id, "id", "Subcategory");
  await categories.updateSubcategory(ctx, userId, { id: sub._id, name: input.name });
  return { subcategory: await getSubcategory(ctx, sub._id) };
});

export const archiveSubcategory = apiMutation(routes.subcategories.archive, async (ctx, userId, input) => {
  const sub = await requireOwned(ctx, userId, "subcategories", input.id, "id", "Subcategory");
  await categories.archiveSubcategory(ctx, userId, { id: sub._id });
  return { subcategory: await getSubcategory(ctx, sub._id) };
});

export const restoreSubcategory = apiMutation(routes.subcategories.restore, async (ctx, userId, input) => {
  const sub = await requireOwned(ctx, userId, "subcategories", input.id, "id", "Subcategory");
  await categories.restoreSubcategory(ctx, userId, { id: sub._id });
  return { subcategory: await getSubcategory(ctx, sub._id) };
});

export const removeSubcategory = apiMutation(routes.subcategories.delete, async (ctx, userId, input) => {
  const sub = await requireOwned(ctx, userId, "subcategories", input.id, "id", "Subcategory");
  await categories.deleteSubcategory(ctx, userId, { id: sub._id });
  return { id: sub._id as string };
});
