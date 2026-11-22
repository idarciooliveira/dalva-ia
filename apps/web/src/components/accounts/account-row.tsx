import { useState } from "react";
import type { Account } from "@mpf/finance-contract";
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
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { ACCOUNT_TYPES, ACCOUNT_THEMES } from "@/lib/accounts";

interface AccountRowProps {
  account: Account;
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

  const { mutate: archiveAccount, isPending: isArchiving } = useApiMutation("accounts", "archive", {
    onMutate: () => setDeleteError(null),
    onError: (error) => {
      setDeleteError(apiErrorMessage(error, "Couldn't archive the account. Try again."));
      setCanArchive(false);
    },
    onSuccess: () => setCanArchive(false),
  });
  const { mutate: restoreAccount, isPending: isRestoring } = useApiMutation("accounts", "restore", {
    onMutate: () => setDeleteError(null),
    onError: (error) => setDeleteError(apiErrorMessage(error, "Couldn't restore the account. Try again.")),
  });
  const { mutate: deleteAccount, isPending: isDeleting } = useApiMutation("accounts", "delete", {
    onMutate: () => setDeleteError(null),
    // Accounts with transactions, goals or debts can't be deleted (`conflict`); archive instead.
    onError: (error) => {
      const inUse = isApiError(error, "conflict");
      setDeleteError(
        inUse
          ? "This account has transactions, goals or debts linked to it, so it can't be deleted."
          : apiErrorMessage(error, "Couldn't delete the account. Try again."),
      );
      setCanArchive(inUse);
    },
  });
  const isBusy = isArchiving || isRestoring || isDeleting;

  const balance = account.balance.amountMinor;
  const currency = account.balance.currency;
  const isNegative = balance < 0;

  return (
    <div role="listitem" aria-label={account.name}>
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
          {accountType?.label ?? account.type} · {currency}
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
          {formatMinor(Math.abs(balance), currency)}
        </span>
        {isNegative && (
          <span className="ml-1 text-xs text-destructive sm:text-sm">owing</span>
        )}
      </div>

      {/* Actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={`Open ${account.name} actions`}
          >
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
              disabled={isBusy}
              onClick={() => restoreAccount({ id: account.id })}
            >
              <ArchiveRestore className="mr-2 size-4" />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={isBusy}
              onClick={() => archiveAccount({ id: account.id })}
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
        title="Delete account"
        description="Delete this account? This cannot be undone."
        onConfirm={() => deleteAccount({ id: account.id })}
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
            disabled={isBusy}
            onClick={() => {
              archiveAccount({ id: account.id });
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
