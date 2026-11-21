import { routes } from "@mpf/finance-contract";

import * as categories from "../../domain/categories";
import { operation } from "../operation";
import { categoryDto, subcategoryDto, toId } from "./shared";

export const categoryOperations = {
  list: operation(routes.categories.list, async (tx, user, input) => {
    const rows = await categories.listCategories(tx, user.userId, { includeArchived: input.includeArchived });
    return { items: rows.map(categoryDto) };
  }),

  defaults: operation(routes.categories.defaults, async () => ({ items: categories.DEFAULT_CATEGORIES })),

  seedDefaults: operation(routes.categories.seedDefaults, async (tx, user, input) => {
    const rows = await categories.seedDefaultCategories(tx, user.userId, { selectedNames: input.selectedNames });
    return { items: rows.map(categoryDto) };
  }),

  create: operation(routes.categories.create, async (tx, user, input) => {
    return { category: categoryDto(await categories.createCategory(tx, user.userId, input)) };
  }),

  update: operation(routes.categories.update, async (tx, user, input) => {
    const { id, ...fields } = input;
    return { category: categoryDto(await categories.updateCategory(tx, user.userId, toId(id, "id"), fields)) };
  }),

  archive: operation(routes.categories.archive, async (tx, user, input) => {
    return { category: categoryDto(await categories.archiveCategory(tx, user.userId, toId(input.id, "id"))) };
  }),

  restore: operation(routes.categories.restore, async (tx, user, input) => {
    return { category: categoryDto(await categories.restoreCategory(tx, user.userId, toId(input.id, "id"))) };
  }),

  delete: operation(routes.categories.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await categories.deleteCategory(tx, user.userId, id);
    return { id };
  }),
};

export const subcategoryOperations = {
  /** Without `categoryId`, every category's; with one, it must be the caller's (`not_found` otherwise). */
  list: operation(routes.subcategories.list, async (tx, user, input) => {
    const { includeArchived } = input;
    if (!input.categoryId) {
      return { items: (await categories.listAllSubcategories(tx, user.userId, { includeArchived })).map(subcategoryDto) };
    }
    const category = await categories.getCategory(tx, user.userId, toId(input.categoryId, "categoryId"));
    const rows = await categories.listSubcategories(tx, user.userId, { categoryId: category.id, includeArchived });
    return { items: rows.map(subcategoryDto) };
  }),

  create: operation(routes.subcategories.create, async (tx, user, input) => {
    const categoryId = toId(input.categoryId, "categoryId");
    return { subcategory: subcategoryDto(await categories.createSubcategory(tx, user.userId, { categoryId, name: input.name })) };
  }),

  update: operation(routes.subcategories.update, async (tx, user, input) => {
    return { subcategory: subcategoryDto(await categories.updateSubcategory(tx, user.userId, toId(input.id, "id"), { name: input.name })) };
  }),

  archive: operation(routes.subcategories.archive, async (tx, user, input) => {
    return { subcategory: subcategoryDto(await categories.updateSubcategory(tx, user.userId, toId(input.id, "id"), { archived: true })) };
  }),

  restore: operation(routes.subcategories.restore, async (tx, user, input) => {
    return { subcategory: subcategoryDto(await categories.updateSubcategory(tx, user.userId, toId(input.id, "id"), { archived: false })) };
  }),

  delete: operation(routes.subcategories.delete, async (tx, user, input) => {
    const id = toId(input.id, "id");
    await categories.deleteSubcategory(tx, user.userId, id);
    return { id };
  }),
};
