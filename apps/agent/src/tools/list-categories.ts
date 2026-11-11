import { tool } from "ai";
import { z } from "zod";

import { bounded, call, clip, compact, guarded, includeArchivedInput, NAME_MAX, type ToolContext } from "./shared";

const MAX_CATEGORIES = 40;
const MAX_SUBCATEGORIES = 15;

export const listCategories = (context: ToolContext) =>
  tool({
    description: "List the user's income and expense categories, each with its subcategories. Use the ids to filter transactions.",
    inputSchema: z.object({
      type: z.enum(["income", "expense"]).optional().describe("Only income or only expense categories."),
      includeArchived: includeArchivedInput,
    }),
    execute: ({ type, includeArchived }) =>
      guarded(context, async () => {
        const archived = includeArchived ?? false;
        const [categories, subcategories] = await Promise.all([
          context.finance.categories.list({ includeArchived: archived }, call(context)),
          context.finance.subcategories.list({ includeArchived: archived }, call(context)),
        ]);
        const visible = categories.items.filter((c) => (!type || c.type === type) && (archived || !c.archived));
        const { items, truncated } = bounded(visible, MAX_CATEGORIES);
        let subcategoriesCut = false;
        return compact({
          categories: items.map((category) => {
            const all = subcategories.items
              .filter((sub) => sub.categoryId === category.id && (archived || !sub.archived))
              .sort((a, b) => a.sortOrder - b.sortOrder);
            const subs = all.slice(0, MAX_SUBCATEGORIES).map((sub) => ({ id: sub.id, name: clip(sub.name, NAME_MAX) }));
            if (all.length > MAX_SUBCATEGORIES) subcategoriesCut = true;
            return compact({
              id: category.id,
              name: clip(category.name, NAME_MAX),
              type: category.type,
              archived: category.archived || undefined,
              subcategories: subs,
              subcategoriesTruncated: all.length > MAX_SUBCATEGORIES || undefined,
            });
          }),
          truncated: truncated || subcategoriesCut || undefined,
        });
      }),
  });
