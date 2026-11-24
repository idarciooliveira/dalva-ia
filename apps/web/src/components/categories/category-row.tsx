import { useState } from "react";
import type { Category, Subcategory } from "@/lib/api/types";
import {
  Plus,
  MoreVertical,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { FormError } from "@/components/error-state";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";
import { getCategoryIcon } from "@/lib/category-icons";
import { cn } from "@/lib/utils";
import { SubcategoryRow } from "./subcategory-row";

interface CategoryRowProps {
  category: Category;
  subcategories: Subcategory[];
  onEdit: () => void;
  onAddSubcategory: () => void;
  onEditSubcategory: (subcategory: Subcategory) => void;
}

export function CategoryRow({
  category,
  subcategories,
  onEdit,
  onAddSubcategory,
  onEditSubcategory,
}: CategoryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const Icon = getCategoryIcon(category.icon ?? "circle");

  const [actionError, setActionError] = useState<string | null>(null);
  const handlers = (failure: string) => ({
    onMutate: () => setActionError(null),
    onError: (error: Error) => setActionError(apiErrorMessage(error, failure)),
  });
  const { mutate: archiveCategory, isPending: isArchiving } = useApiMutation(
    "categories",
    "archive",
    handlers("Couldn't archive the category. Try again."),
  );
  const { mutate: restoreCategory, isPending: isRestoring } = useApiMutation(
    "categories",
    "restore",
    handlers("Couldn't restore the category. Try again."),
  );
  const { mutate: deleteCategory, isPending: isDeleting } = useApiMutation(
    "categories",
    "delete",
    handlers("Couldn't delete the category. Try again."),
  );
  const isBusy = isArchiving || isRestoring || isDeleting;

  const sortedSubs = [...subcategories].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const hasSubcategories = sortedSubs.length > 0;

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-card transition-colors",
        category.archived && "opacity-60",
      )}
    >
      {/* Main row */}
      <div className="flex min-h-20 items-start gap-3 px-3 py-3.5 sm:min-h-22 sm:items-center sm:gap-5 sm:px-5 sm:py-4">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${category.name} subcategories`}
        >
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>

        {/* Icon */}
        <div
          className="flex size-10 items-center justify-center rounded-xl sm:size-12"
          style={{ backgroundColor: (category.color ?? "#6B7280") + "20" }}
        >
          <Icon className="size-4.5 sm:size-5" style={{ color: category.color ?? "#6B7280" }} />
        </div>

        {/* Name */}
        <div className="min-w-0 flex-1 pt-0.5 sm:pt-0">
          <p className="break-words text-sm font-medium text-foreground sm:text-base">
            {category.name}
          </p>
          {(category.archived || hasSubcategories) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:gap-2">
              {category.archived && (
                <Badge variant="secondary" className="text-[10px]">
                  Archived
                </Badge>
              )}
              {hasSubcategories && (
                <span className="text-xs text-muted-foreground sm:text-sm">
                  {sortedSubs.length} subcategor{sortedSubs.length === 1 ? "y" : "ies"}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Default badge — hidden on mobile to avoid crowding */}
        {category.isDefault && (
          <Badge
            variant="outline"
            className="mt-0.5 hidden shrink-0 text-[10px] font-normal sm:mt-0 sm:inline-flex"
          >
            Default
          </Badge>
        )}

        {/* Actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mt-0.5 shrink-0 text-muted-foreground sm:mt-0"
              aria-label={`Open ${category.name} actions`}
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 size-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onAddSubcategory}>
              <Plus className="mr-2 size-4" />
              Add subcategory
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {category.archived ? (
              <DropdownMenuItem
                disabled={isBusy}
                onClick={() => restoreCategory({ id: category.id })}
              >
                <ArchiveRestore className="mr-2 size-4" />
                Restore
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={isBusy}
                onClick={() => archiveCategory({ id: category.id })}
              >
                <Archive className="mr-2 size-4" />
                Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={isBusy}
              className="text-destructive focus:text-destructive"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="mr-2 size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ConfirmDeleteDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="Delete category"
          description="Delete this category and all its subcategories? This cannot be undone."
          onConfirm={() => deleteCategory({ id: category.id })}
        />
      </div>

      <FormError message={actionError} className="mt-0 px-3 pb-3 sm:px-5" />

      {/* Subcategories (expanded) */}
      {expanded && (
        <div className="border-t border-border/40 px-3 pb-3.5 pt-2.5 sm:px-5 sm:pb-4 sm:pt-3">
          {sortedSubs.length === 0 ? (
            <p className="py-2 pl-8 text-sm text-muted-foreground sm:pl-10">
              No subcategories.{" "}
              <button
                type="button"
                className="text-primary underline-offset-4 hover:underline"
                onClick={onAddSubcategory}
              >
                Add one
              </button>
            </p>
          ) : (
            <div className="space-y-0.5 sm:space-y-1">
              {sortedSubs.map((sub) => (
                <SubcategoryRow
                  key={sub.id}
                  subcategory={sub}
                  parentColor={category.color ?? "#6B7280"}
                  onEdit={() => onEditSubcategory(sub)}
                />
              ))}
            </div>
          )}
          <button
            type="button"
            className="mt-2.5 flex items-center gap-1.5 pl-8 text-sm font-medium text-primary underline-offset-4 hover:underline sm:mt-3 sm:pl-10"
            onClick={onAddSubcategory}
          >
            <Plus className="size-3.5" />
            Add subcategory
          </button>
        </div>
      )}
    </div>
  );
}
