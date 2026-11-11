import { routes } from "@mpf/finance-contract";

import * as categories from "../../domain/categories";
import { apiQuery } from "./define";
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
