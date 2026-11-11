import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useConvexMutation } from "@convex-dev/react-query";
import { api } from "@mpf/backend/convex/_generated/api";
import type { Doc } from "@mpf/backend/convex/_generated/dataModel";
import {
  MoreVertical,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  Scale,
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
import { ACCOUNT_IN_USE, convexErrorMessage } from "@/lib/convex-errors";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { ACCOUNT_TYPES, ACCOUNT_THEMES } from "@/lib/accounts";

interface AccountRowProps {
  account: Doc<"accounts">;
  onEdit: () => void;
  onAdjustBalance: () => void;
}

export function AccountRow({ account, onEdit, onAdjustBalance }: AccountRowProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [canArchive, setCanArchive] = useState(false);

  const accountType = ACCOUNT_TYPES.find((t) => t.value === account.type);
  const Icon = accountType?.icon;
  const theme = ACCOUNT_THEMES.find((t) => t.id === (account.theme ?? "default")) ?? ACCOUNT_THEMES[0];

  const { mutate: archiveAccount } = useMutation({
    mutationFn: useConvexMutation(api.accounts.archiveAccount),
    onMutate: () => setDeleteError(null),
    onError: () => {
      setDeleteError("Couldn't archive the account. Try again.");
      setCanArchive(false);
    },
  });
  const { mutate: restoreAccount } = useMutation({
    mutationFn: useConvexMutation(api.accounts.restoreAccount),
  });
  const { mutate: deleteAccount } = useMutation({
    mutationFn: useConvexMutation(api.accounts.deleteAccount),
    onMutate: () => setDeleteError(null),
    // Accounts with transactions, goals or debts can't be deleted; archive instead.
    onError: (error) => {
      setDeleteError(
        convexErrorMessage(error, ACCOUNT_IN_USE)
          ? "This account has transactions, goals or debts linked to it, so it can't be deleted."
          : "Couldn't delete the account. Try again.",
      );
      setCanArchive(convexErrorMessage(error, ACCOUNT_IN_USE) !== null);
    },
  });

  const isNegative = account.balance < 0;

  return (
    <div>
    <div
      className={cn(
        "flex min-h-20 items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-3.5 transition-colors sm:min-h-22 sm:gap-5 sm:px-5 sm:py-4",
        account.archived && "opacity-60",
      )}
    >
      {/* Icon with theme color */}
      <div
        className="flex size-10 items-center justify-center rounded-xl sm:size-12"
        style={{
          background: `linear-gradient(135deg, ${theme.from}, ${theme.to})`,
        }}
      >
          {Icon && <Icon className="size-4.5 text-white sm:size-5.5" />}
      </div>

      {/* Name + type */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground sm:text-base">
            {account.name}
          </span>
          {account.archived && (
            <Badge variant="secondary" className="text-[10px]">
              Archived
            </Badge>
          )}
        </div>
        <span className="mt-0.5 block text-xs text-muted-foreground sm:mt-1 sm:text-sm">
          {accountType?.label ?? account.type} · {account.currency}
        </span>
      </div>

      {/* Balance */}
      <div className="shrink-0 text-right">
        <span
          className={cn(
            "text-lg font-semibold tabular-nums sm:text-xl",
            isNegative ? "text-destructive" : "text-foreground",
          )}
        >
          {formatCurrency(Math.abs(account.balance), account.currency)}
        </span>
        {isNegative && (
          <span className="ml-1 text-xs text-destructive sm:text-sm">owing</span>
        )}
      </div>

      {/* Actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 size-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAdjustBalance}>
            <Scale className="mr-2 size-4" />
            Adjust balance
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {account.archived ? (
            <DropdownMenuItem
              onClick={() => restoreAccount({ id: account._id })}
            >
              <ArchiveRestore className="mr-2 size-4" />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => archiveAccount({ id: account._id })}
            >
              <Archive className="mr-2 size-4" />
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
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
        title="Delete account"
        description="Delete this account? This cannot be undone."
        onConfirm={() => deleteAccount({ id: account._id })}
      />
    </div>
    {deleteError && (
      <p
        role="alert"
        className="mt-2 flex flex-wrap items-center gap-2 px-3 text-sm text-destructive sm:px-5"
      >
        {deleteError}
        {canArchive && !account.archived && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              archiveAccount({ id: account._id });
            }}
          >
            Archive instead
          </Button>
        )}
      </p>
    )}
    </div>
  );
}
