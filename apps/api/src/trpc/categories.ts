/** Categories and their subcategories. Seeded during onboarding, then the user's own. */
import { z } from "zod";

import { categoryType } from "../db/schema";
import * as categories from "../domain/categories";
import { categoryDto, subcategoryDto } from "./dto";
import { financeRead, router, webRead, webWrite } from "./init";
import { byId, deleted, hasChangesBesidesId, idSchema, list, nameField, NO_CHANGES, noInput, shortText, styleField } from "./schemas";

export const categoryTypeSchema = z.enum(categoryType.enumValues);

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: categoryTypeSchema,
  icon: z.string().optional(),
  color: z.string().optional(),
  isDefault: z.boolean(),
  archived: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

export const subcategorySchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  archived: z.boolean(),
  sortOrder: z.number(),
});

/** A category onboarding offers. `name` is what `seedDefaults` selects by. */
export const defaultCategorySchema = z.object({ name: z.string(), type: categoryTypeSchema, icon: z.string(), color: z.string() });

const categoryResult = z.object({ category: categorySchema });
const subcategoryResult = z.object({ subcategory: subcategorySchema });

export const categoriesRouter = router({
  list: financeRead
    .input(z.strictObject({ includeArchived: z.boolean().optional() }).prefault({}))
    .output(list(categorySchema))
    .query(async ({ ctx, input }) => {
      const rows = await categories.listCategories(ctx.tx, ctx.user.userId, { includeArchived: input.includeArchived });
      return { items: rows.map(categoryDto) };
    }),

  /** What onboarding offers, in this order. */
  defaults: webRead
    .input(noInput)
    .output(list(defaultCategorySchema))
    .query(() => ({ items: categories.DEFAULT_CATEGORIES })),

  /**
   * Onboarding: create the selected defaults (`isDefault: true`), or all of
   * them when `selectedNames` is empty; unknown names are ignored. Does
   * nothing once the user has any category, archived included. Returns what
   * it created.
   */
  seedDefaults: webWrite
    .input(z.strictObject({ selectedNames: z.array(shortText(100)).max(50) }))
    .output(list(categorySchema))
    .mutation(async ({ ctx, input }) => {
      const rows = await categories.seedDefaultCategories(ctx.tx, ctx.user.userId, { selectedNames: input.selectedNames });
      return { items: rows.map(categoryDto) };
    }),

  /** Placed last within its type. Names are not unique. */
  create: webWrite
    .input(z.strictObject({ name: nameField, type: categoryTypeSchema, icon: styleField, color: styleField }))
    .output(categoryResult)
    .mutation(async ({ ctx, input }) => ({ category: categoryDto(await categories.createCategory(ctx.tx, ctx.user.userId, input)) })),

  /** Only the given fields change. The type can't be changed. */
  update: webWrite
    .input(
      z
        .strictObject({ id: idSchema, name: nameField.optional(), icon: styleField.optional(), color: styleField.optional() })
        .refine(hasChangesBesidesId, { message: NO_CHANGES }),
    )
    .output(categoryResult)
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      return { category: categoryDto(await categories.updateCategory(ctx.tx, ctx.user.userId, id, fields)) };
    }),

  /** Hidden from `list` unless `includeArchived`; archives its subcategories too. Transactions keep it. */
  archive: webWrite
    .input(byId)
    .output(categoryResult)
    .mutation(async ({ ctx, input }) => ({ category: categoryDto(await categories.archiveCategory(ctx.tx, ctx.user.userId, input.id)) })),

  /** The category only: its subcategories stay archived until restored one by one. */
  restore: webWrite
    .input(byId)
    .output(categoryResult)
    .mutation(async ({ ctx, input }) => ({ category: categoryDto(await categories.restoreCategory(ctx.tx, ctx.user.userId, input.id)) })),

  /** For good, with its subcategories, even while transactions use them: those become uncategorised. */
  delete: webWrite
    .input(byId)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await categories.deleteCategory(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});

export const subcategoriesRouter = router({
  /** Without `categoryId`, every category's; with one, it must be the caller's (`not_found` otherwise). */
  list: financeRead
    .input(z.strictObject({ categoryId: idSchema.optional(), includeArchived: z.boolean().optional() }).prefault({}))
    .output(list(subcategorySchema))
    .query(async ({ ctx, input }) => {
      const { includeArchived } = input;
      if (!input.categoryId) {
        return { items: (await categories.listAllSubcategories(ctx.tx, ctx.user.userId, { includeArchived })).map(subcategoryDto) };
      }
      const category = await categories.getCategory(ctx.tx, ctx.user.userId, input.categoryId);
      const rows = await categories.listSubcategories(ctx.tx, ctx.user.userId, { categoryId: category.id, includeArchived });
      return { items: rows.map(subcategoryDto) };
    }),

  /** Placed last within its category. The parent may be archived. */
  create: webWrite
    .input(z.strictObject({ categoryId: idSchema, name: nameField }))
    .output(subcategoryResult)
    .mutation(async ({ ctx, input }) => ({
      subcategory: subcategoryDto(await categories.createSubcategory(ctx.tx, ctx.user.userId, { categoryId: input.categoryId, name: input.name })),
    })),

  /** Rename. The parent category can't be changed. */
  update: webWrite
    .input(z.strictObject({ id: idSchema, name: nameField }))
    .output(subcategoryResult)
    .mutation(async ({ ctx, input }) => ({
      subcategory: subcategoryDto(await categories.updateSubcategory(ctx.tx, ctx.user.userId, input.id, { name: input.name })),
    })),

  archive: webWrite
    .input(byId)
    .output(subcategoryResult)
    .mutation(async ({ ctx, input }) => ({
      subcategory: subcategoryDto(await categories.updateSubcategory(ctx.tx, ctx.user.userId, input.id, { archived: true })),
    })),

  restore: webWrite
    .input(byId)
    .output(subcategoryResult)
    .mutation(async ({ ctx, input }) => ({
      subcategory: subcategoryDto(await categories.updateSubcategory(ctx.tx, ctx.user.userId, input.id, { archived: false })),
    })),

  /** For good, even while transactions use it: they keep the category and lose the subcategory. */
  delete: webWrite
    .input(byId)
    .output(deleted)
    .mutation(async ({ ctx, input }) => {
      await categories.deleteSubcategory(ctx.tx, ctx.user.userId, input.id);
      return { id: input.id };
    }),
});
