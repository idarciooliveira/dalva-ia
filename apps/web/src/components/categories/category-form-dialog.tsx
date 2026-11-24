import { useEffect, useState } from "react";
import type { Category } from "@/lib/api/types";
import { Palette, Check, Image } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AVAILABLE_ICONS,
  CATEGORY_COLORS,
  CATEGORY_ICON_MAP,
} from "@/lib/category-icons";
import { cn } from "@/lib/utils";
import { FormError } from "@/components/error-state";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";

/** How many color swatches / icons to show before the "Others" toggle. */
const COLORS_PREVIEW_COUNT = 4;
const ICONS_PREVIEW_COUNT = 4;

interface CategoryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: "income" | "expense";
  category: Category | null;
}

export function CategoryFormDialog({
  open,
  onOpenChange,
  type,
  category,
}: CategoryFormDialogProps) {
  const isEdit = category !== null;

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("wallet");
  const [color, setColor] = useState(CATEGORY_COLORS[0]!);
  const [error, setError] = useState("");
  const [showAllColors, setShowAllColors] = useState(false);
  const [showAllIcons, setShowAllIcons] = useState(false);

  // Sync form state when dialog opens
  useEffect(() => {
    if (category) {
      setName(category.name);
      setIcon(category.icon ?? "circle");
      setColor(category.color ?? CATEGORY_COLORS[0]!);
    } else {
      setName("");
      setIcon(type === "income" ? "banknote" : "wallet");
      setColor(CATEGORY_COLORS[0]!);
    }
    setError("");
    setShowAllColors(false);
    setShowAllIcons(false);
  }, [category, type, open]);

  const { mutateAsync: createCategory, isPending: isCreating } = useApiMutation("categories", "create");
  const { mutateAsync: updateCategory, isPending: isUpdating } = useApiMutation("categories", "update");

  const isPending = isCreating || isUpdating;

  async function handleSubmit(andCreateNew = false) {
    setError("");

    if (!name.trim()) {
      setError("Category name is required");
      return;
    }

    try {
      if (isEdit && category) {
        await updateCategory({
          id: category.id,
          name: name.trim(),
          icon,
          color,
        });
        onOpenChange(false);
        return;
      }

      await createCategory({ name: name.trim(), type, icon, color });

      if (andCreateNew) {
        setName("");
        setIcon(type === "income" ? "banknote" : "wallet");
        setColor(CATEGORY_COLORS[0]!);
        setError("");
        setShowAllColors(false);
        setShowAllIcons(false);
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(apiErrorMessage(err, isEdit ? "Couldn't save the category. Try again." : "Couldn't create the category. Try again."));
    }
  }

  // Ensure the currently-selected color/icon is always visible in the preview row
  const visibleColors = getVisibleItems(
    CATEGORY_COLORS,
    color,
    COLORS_PREVIEW_COUNT,
    showAllColors,
  );
  const visibleIcons = getVisibleItems(
    AVAILABLE_ICONS,
    icon,
    ICONS_PREVIEW_COUNT,
    showAllIcons,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden flex flex-col max-h-[85vh] sm:h-105">
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-0 shrink-0">
          <DialogTitle className="text-lg font-semibold">
            {isEdit ? "Edit category" : `New ${type} category`}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose a name, a color and an icon for the category.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-4 pb-2">
          {/* ── Name field (underline input) ── */}
          <div className="border-b border-border pb-2 mb-5">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              autoFocus
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60 sm:text-base"
              aria-label="Category name"
            />
          </div>

          {/* ── Color & Icon side by side (stacked on narrow screens) ── */}
          <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
            {/* Color column */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <Palette className="size-5 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">
                  Category color
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {visibleColors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      "relative size-9 rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:size-10",
                      color === c && "scale-110",
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                    aria-pressed={color === c}
                  >
                    {color === c && (
                      <Check className="absolute inset-0 m-auto size-4.5 text-white drop-shadow-md" />
                    )}
                  </button>
                ))}
              </div>
              {!showAllColors &&
                CATEGORY_COLORS.length > COLORS_PREVIEW_COUNT && (
                  <button
                    type="button"
                    onClick={() => setShowAllColors(true)}
                    className="mt-2.5 rounded-full bg-muted/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted transition-colors"
                  >
                    Others
                  </button>
                )}
              {showAllColors && (
                <button
                  type="button"
                  onClick={() => setShowAllColors(false)}
                  className="mt-2.5 rounded-full bg-muted/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted transition-colors"
                >
                  Less
                </button>
              )}
            </div>

            {/* Icon column */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <Image className="size-5 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground">Icon</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {visibleIcons.map((iconName) => {
                  const IconComp = CATEGORY_ICON_MAP[iconName];
                  if (!IconComp) return null;
                  return (
                    <button
                      key={iconName}
                      type="button"
                      onClick={() => setIcon(iconName)}
                      className={cn(
                        "flex size-9 items-center justify-center rounded-full transition-colors sm:size-10",
                        icon === iconName
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      title={iconName}
                      aria-label={`Icon: ${iconName}`}
                      aria-pressed={icon === iconName}
                    >
                      <IconComp className="size-5" />
                    </button>
                  );
                })}
              </div>
              {!showAllIcons &&
                AVAILABLE_ICONS.length > ICONS_PREVIEW_COUNT && (
                  <button
                    type="button"
                    onClick={() => setShowAllIcons(true)}
                    className="mt-2.5 rounded-full bg-muted/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted transition-colors"
                  >
                    Others
                  </button>
                )}
              {showAllIcons && (
                <button
                  type="button"
                  onClick={() => setShowAllIcons(false)}
                  className="mt-2.5 rounded-full bg-muted/60 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted transition-colors"
                >
                  Less
                </button>
              )}
            </div>
          </div>

          {/* ── Error ── */}
          <FormError message={error} className="mt-4" />
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 shrink-0">
          {!isEdit && (
            <Button
              type="button"
              variant="ghost"
              size="default"
              className="flex-1 rounded-full text-muted-foreground sm:flex-none"
              disabled={isPending || !name.trim()}
              onClick={() => void handleSubmit(true)}
            >
              {isPending ? "Saving..." : "Save & new"}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="default"
            className="flex-1 rounded-full px-8 sm:flex-none"
            disabled={isPending || !name.trim()}
            onClick={() => void handleSubmit(false)}
          >
            {isPending ? "Saving..." : isEdit ? "Save" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Return the items to display. When collapsed, shows the first N items but
 * swaps in the currently-selected item if it falls outside that range so the
 * user always sees their selection.
 */
function getVisibleItems<T>(
  all: T[],
  selected: T,
  previewCount: number,
  showAll: boolean,
): T[] {
  if (showAll) return all;

  const preview = all.slice(0, previewCount);
  const selectedIdx = all.indexOf(selected);

  // Selected item is already in the preview range
  if (selectedIdx < previewCount) return preview;

  // Swap the last preview item with the selected one so it's always visible
  return [...preview.slice(0, previewCount - 1), selected];
}
