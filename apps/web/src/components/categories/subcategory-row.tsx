import { useState } from "react";
import type { Subcategory } from "@mpf/finance-contract";
import {
  MoreVertical,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { FormError } from "@/components/error-state";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

interface SubcategoryRowProps {
  subcategory: Subcategory;
  parentColor: string;
  onEdit: () => void;
}

export function SubcategoryRow({
  subcategory,
  parentColor,
  onEdit,
}: SubcategoryRowProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const handlers = (failure: string) => ({
    onMutate: () => setActionError(null),
    onError: (error: Error) => setActionError(apiErrorMessage(error, failure)),
  });
  const { mutate: archiveSub, isPending: isArchiving } = useApiMutation(
    "subcategories",
    "archive",
    handlers("Couldn't archive the subcategory. Try again."),
  );
  const { mutate: restoreSub, isPending: isRestoring } = useApiMutation(
    "subcategories",
    "restore",
    handlers("Couldn't restore the subcategory. Try again."),
  );
  const { mutate: deleteSub, isPending: isDeleting } = useApiMutation(
    "subcategories",
    "delete",
    handlers("Couldn't delete the subcategory. Try again."),
  );
  const isBusy = isArchiving || isRestoring || isDeleting;

  return (
    <div>
    <div
      className={cn(
        "flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2.5 pl-8 hover:bg-muted/50 sm:min-h-12 sm:gap-3 sm:px-4 sm:py-3 sm:pl-10",
        subcategory.archived && "opacity-60",
      )}
    >
      {/* Small dot with parent color */}
      <div
        className="size-2 rounded-full"
        style={{ backgroundColor: parentColor }}
      />
      <span className="flex-1 text-sm font-medium text-foreground">
        {subcategory.name}
      </span>
      {subcategory.archived && (
        <Badge variant="secondary" className="text-[10px]">
          Archived
        </Badge>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={`Open ${subcategory.name} actions`}
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 size-4" />
            Edit
          </DropdownMenuItem>
          {subcategory.archived ? (
            <DropdownMenuItem disabled={isBusy} onClick={() => restoreSub({ id: subcategory.id })}>
              <ArchiveRestore className="mr-2 size-4" />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={isBusy} onClick={() => archiveSub({ id: subcategory.id })}>
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
        title="Delete subcategory"
        description="Delete this subcategory? This cannot be undone."
        onConfirm={() => deleteSub({ id: subcategory.id })}
      />
    </div>
    <FormError message={actionError} className="mt-1 pl-8 sm:pl-10" />
    </div>
  );
}
