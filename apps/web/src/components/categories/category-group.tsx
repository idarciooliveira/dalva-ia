import { Plus } from "lucide-react";
import type { Category, Subcategory } from "@mpf/finance-contract";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CategoryRow } from "./category-row";

interface CategoryGroupProps {
  title: string;
  type: "income" | "expense";
  categories: Category[];
  subcategoriesByParent: Map<string, Subcategory[]>;
  onCreateCategory: () => void;
  onEditCategory: (category: Category) => void;
  onAddSubcategory: (category: Category) => void;
  onEditSubcategory: (subcategory: Subcategory) => void;
}

export function CategoryGroup({
  title,
  type,
  categories,
  subcategoriesByParent,
  onCreateCategory,
  onEditCategory,
  onAddSubcategory,
  onEditSubcategory,
}: CategoryGroupProps) {
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          <Badge
            variant="secondary"
            className="shrink-0 text-[10px] font-normal"
          >
            {categories.length}
          </Badge>
        </div>
        <Button
          variant="accent"
          size="default"
          onClick={onCreateCategory}
          className="w-full sm:w-auto sm:shrink-0"
        >
          <Plus className="mr-1.5 size-4" />
          Add {type === "income" ? "income" : "expense"} category
        </Button>
      </div>

      <div className="space-y-3">
        {categories.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No {type} categories yet.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateCategory}
              className="mt-3 gap-1.5"
            >
              <Plus className="size-3.5" />
              Create one
            </Button>
          </div>
        ) : (
          categories.map((category) => (
            <CategoryRow
              key={category.id}
              category={category}
              subcategories={subcategoriesByParent.get(category.id) ?? []}
              onEdit={() => onEditCategory(category)}
              onAddSubcategory={() => onAddSubcategory(category)}
              onEditSubcategory={onEditSubcategory}
            />
          ))
        )}
      </div>
    </div>
  );
}
