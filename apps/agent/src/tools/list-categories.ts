import { tool } from "ai";
import { z } from "zod";

import { bounded, compact, guarded, includeArchivedInput, type ToolContext } from "./shared";

const MAX_CATEGORIES = 60;
const MAX_SUBCATEGORIES = 30;

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
          context.finance.categories.list({ includeArchived: archived }),
          context.finance.subcategories.list({ includeArchived: archived }),
        ]);
        const visible = categories.items.filter((c) => (!type || c.type === type) && (archived || !c.archived));
        const { items, truncated } = bounded(visible, MAX_CATEGORIES);
        return compact({
          categories: items.map((category) => {
            const subs = subcategories.items
              .filter((sub) => sub.categoryId === category.id && (archived || !sub.archived))
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .slice(0, MAX_SUBCATEGORIES)
              .map((sub) => ({ id: sub.id, name: sub.name }));
            return compact({
              id: category.id,
              name: category.name,
              type: category.type,
              archived: category.archived || undefined,
              subcategories: subs,
            });
          }),
          truncated: truncated || undefined,
        });
      }),
  });
