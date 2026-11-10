import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getOptionalUserId, requireUserId } from "./lib/auth";
import * as categoriesDomain from "./domain/categories";

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * List all categories for the current user.
 * By default excludes archived categories. Pass `includeArchived: true` to
 * include them (e.g. for settings pages).
 */
export const listCategories = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return [];

    return await categoriesDomain.listCategories(ctx, userId, args);
  },
});

/**
 * List subcategories for a given parent category.
 */
export const listSubcategories = query({
  args: {
    categoryId: v.id("categories"),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return [];

    return await categoriesDomain.listSubcategories(ctx, userId, args);
  },
});

/**
 * List ALL subcategories for the current user (all categories at once).
 * Useful for the categories management page to avoid N+1 queries.
 */
export const listAllSubcategories = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getOptionalUserId(ctx);
    if (!userId) return [];

    return await categoriesDomain.listAllSubcategories(ctx, userId, args);
  },
});

/**
 * Exported for use on the frontend to display the default set during onboarding.
 */
export const getDefaultCategoryList = query({
  args: {},
  handler: async () => {
    return categoriesDomain.DEFAULT_CATEGORIES;
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations – Seed                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Seed default categories for the current user.
 * Idempotent: skips if user already has categories.
 */
export const seedDefaultCategories = mutation({
  args: {
    selectedNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.seedDefaultCategories(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations – Category CRUD                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a custom category.
 */
export const createCategory = mutation({
  args: {
    name: v.string(),
    type: v.union(v.literal("income"), v.literal("expense")),
    icon: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await categoriesDomain.createCategory(ctx, userId, args);
  },
});

/**
 * Update a category's name, icon, or color.
 */
export const updateCategory = mutation({
  args: {
    id: v.id("categories"),
    name: v.optional(v.string()),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.updateCategory(ctx, userId, args);
  },
});

/**
 * Archive a category. Preserves it on historical records but hides from pickers.
 */
export const archiveCategory = mutation({
  args: {
    id: v.id("categories"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.archiveCategory(ctx, userId, args);
  },
});

/**
 * Restore an archived category.
 */
export const restoreCategory = mutation({
  args: {
    id: v.id("categories"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.restoreCategory(ctx, userId, args);
  },
});

/**
 * Delete a category permanently. Only allowed if no transactions reference it.
 * (Transaction check will be added when transactions table exists.)
 */
export const deleteCategory = mutation({
  args: {
    id: v.id("categories"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.deleteCategory(ctx, userId, args);
  },
});

/* -------------------------------------------------------------------------- */
/*  Mutations – Subcategory CRUD                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create a subcategory under a parent category.
 */
export const createSubcategory = mutation({
  args: {
    categoryId: v.id("categories"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await categoriesDomain.createSubcategory(ctx, userId, args);
  },
});

/**
 * Update a subcategory name.
 */
export const updateSubcategory = mutation({
  args: {
    id: v.id("subcategories"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.updateSubcategory(ctx, userId, args);
  },
});

/**
 * Archive a subcategory.
 */
export const archiveSubcategory = mutation({
  args: {
    id: v.id("subcategories"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.archiveSubcategory(ctx, userId, args);
  },
});

/**
 * Restore an archived subcategory.
 */
export const restoreSubcategory = mutation({
  args: {
    id: v.id("subcategories"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.restoreSubcategory(ctx, userId, args);
  },
});

/**
 * Delete a subcategory permanently.
 */
export const deleteSubcategory = mutation({
  args: {
    id: v.id("subcategories"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await categoriesDomain.deleteSubcategory(ctx, userId, args);
  },
});
