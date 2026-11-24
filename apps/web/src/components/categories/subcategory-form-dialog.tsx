import { useEffect, useState } from "react";
import type { Category, Subcategory } from "@/lib/api/types";
import { FileText, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getCategoryIcon } from "@/lib/category-icons";
import { FormError } from "@/components/error-state";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";

interface SubcategoryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentCategory: Category | null;
  subcategory?: Subcategory | null;
}

export function SubcategoryFormDialog({
  open,
  onOpenChange,
  parentCategory,
  subcategory = null,
}: SubcategoryFormDialogProps) {
  const isEdit = subcategory !== null;
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName(subcategory?.name ?? "");
      setError("");
    }
  }, [open, subcategory]);

  const { mutateAsync: createSubcategory, isPending: isCreating } = useApiMutation("subcategories", "create");
  const { mutateAsync: updateSubcategory, isPending: isUpdating } = useApiMutation("subcategories", "update");

  const isPending = isCreating || isUpdating;

  async function handleSubmit(andCreateNew = false) {
    setError("");

    if (!name.trim()) {
      setError("Subcategory name is required");
      return;
    }
    if (!parentCategory) return;

    try {
      if (isEdit && subcategory) {
        await updateSubcategory({
          id: subcategory.id,
          name: name.trim(),
        });
        onOpenChange(false);
        return;
      }

      await createSubcategory({
        categoryId: parentCategory.id,
        name: name.trim(),
      });

      if (andCreateNew) {
        setName("");
        setError("");
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(apiErrorMessage(err, isEdit ? "Couldn't save the subcategory. Try again." : "Couldn't add the subcategory. Try again."));
    }
  }

  const ParentIcon = parentCategory
    ? getCategoryIcon(parentCategory.icon ?? "wallet")
    : null;
  const parentColor = parentCategory?.color ?? "#6B7280";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
          {/* Header */}
          <DialogHeader className="px-5 pt-5 pb-0">
            <DialogTitle className="text-lg font-semibold">
              {isEdit ? "Edit subcategory" : "Add subcategory"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {isEdit
                ? "Rename this subcategory."
                : "Create a subcategory under the selected category."}
            </DialogDescription>
          </DialogHeader>

        <div className="px-5 pt-4 pb-0">
          {/* ── Parent category indicator (icon-led row) ── */}
          {parentCategory && (
            <div className="flex items-center gap-3 border-b border-border py-3">
              <FolderOpen className="size-5 text-muted-foreground shrink-0" />
              <div className="flex items-center gap-2">
                {ParentIcon && (
                  <div
                    className="flex size-6 items-center justify-center rounded-md"
                    style={{ backgroundColor: parentColor + "20" }}
                  >
                    <ParentIcon
                      className="size-3.5"
                      style={{ color: parentColor }}
                    />
                  </div>
                )}
                <span className="text-sm font-medium">
                  {parentCategory.name}
                </span>
              </div>
            </div>
          )}

          {/* ── Name field (icon-led row with bottom border) ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <FileText className="size-5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Groceries"
              autoFocus
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Subcategory name"
            />
          </div>

          {/* ── Error ── */}
          <FormError message={error} />
        </div>

        {/* ── Footer with actions ── */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 mt-2">
          {!isEdit && (
            <Button
              type="button"
              variant="outline"
              size="default"
              className="flex-1 sm:flex-none"
              disabled={isPending || !name.trim()}
              onClick={() => void handleSubmit(true)}
            >
              {isPending ? "Adding..." : "Save & new"}
            </Button>
          )}
          <Button
            type="button"
            variant="accent"
            size="default"
            className="flex-1 sm:flex-none"
            disabled={isPending || !name.trim()}
            onClick={() => void handleSubmit(false)}
          >
            {isPending
              ? isEdit
                ? "Saving..."
                : "Adding..."
              : isEdit
                ? "Save"
                : "Add subcategory"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
