import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useConvexMutation, convexQuery } from "@convex-dev/react-query";
import { api } from "@mpf/backend/convex/_generated/api";
import type { Doc } from "@mpf/backend/convex/_generated/dataModel";
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Scale,
  MoreVertical,
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
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { convexErrorMessage, TRANSACTION_MANAGED } from "@/lib/convex-errors";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";

interface TransactionRowProps {
  transaction: Doc<"transactions">;
  onEdit: () => void;
  /** Optional override for the delete action (used for transfers). */
  onDelete?: () => void;
}

const typeConfig = {
  income: {
    icon: ArrowUpRight,
    iconColor: "text-emerald-500",
    iconBg: "bg-emerald-500/10",
    amountColor: "text-emerald-500",
    prefix: "+",
  },
  expense: {
    icon: ArrowDownRight,
    iconColor: "text-destructive",
    iconBg: "bg-destructive/10",
    amountColor: "text-destructive",
    prefix: "-",
  },
  adjustment: {
    icon: Scale,
    iconColor: "text-primary",
    iconBg: "bg-primary/10",
    amountColor: "text-primary",
    prefix: "",
  },
  transfer: {
    icon: ArrowLeftRight,
    iconColor: "text-blue-500",
    iconBg: "bg-blue-500/10",
    amountColor: "text-blue-500",
    prefix: "",
  },
} as const;

export function TransactionRow({ transaction, onEdit, onDelete }: TransactionRowProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const config = typeConfig[transaction.type];
  const Icon = config.icon;

  // Fetch related account & category names for display
  const { data: account } = useQuery(
    convexQuery(api.accounts.getAccount, { id: transaction.accountId }),
  );

  // Fetch destination account for transfers
  const { data: destAccount } = useQuery(
    convexQuery(
      api.accounts.getAccount,
      transaction.type === "transfer" && transaction.destinationAccountId
        ? { id: transaction.destinationAccountId }
        : "skip",
    ),
  );

  const { data: categories } = useQuery(
    convexQuery(api.categories.listCategories, {}),
  );
  const category = categories?.find((c) => c._id === transaction.categoryId);
  const isAdjustment = transaction.type === "adjustment";
  const isTransfer = transaction.type === "transfer";
  const signedAmount =
    transaction.type === "expense"
      ? -Math.abs(transaction.amount)
      : transaction.amount;

  const { mutate: deleteTransaction } = useMutation({
    mutationFn: useConvexMutation(api.transactions.deleteTransaction),
    onMutate: () => setDeleteError(null),
    // Debt-payment rows are owned by the debts flow and can't be deleted here.
    onError: (error) =>
      setDeleteError(
        convexErrorMessage(error, TRANSACTION_MANAGED) ??
          "Couldn't delete the transaction. Try again.",
      ),
  });

  const { mutate: deleteTransfer } = useMutation({
    mutationFn: useConvexMutation(api.transfers.deleteTransfer),
  });

  // For transfers with destinationAccountId, this is the outgoing side (debit)
  const isOutgoingTransfer = isTransfer && !!transaction.destinationAccountId;

  // Build the subtitle text
  let subtitle: string;
  if (isTransfer) {
    if (isOutgoingTransfer && destAccount) {
      subtitle = `${account?.name ?? ""}  →  ${destAccount.name}`;
    } else if (!isOutgoingTransfer && account) {
      subtitle = `Transfer to ${account.name}`;
    } else {
      subtitle = "Transfer";
    }
  } else if (isAdjustment) {
    subtitle = "Adjustment";
  } else {
    subtitle = category?.name ?? "Uncategorized";
  }
  if (!isTransfer && account) {
    subtitle += ` · ${account.name}`;
  }

  function handleDelete() {
    if (onDelete) {
      onDelete();
    } else if (isTransfer) {
      deleteTransfer({ id: transaction._id });
    } else {
      deleteTransaction({ id: transaction._id });
    }
  }

  return (
    <div>
    <div className="flex min-h-20 items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-3.5 transition-colors sm:min-h-22 sm:gap-5 sm:px-5 sm:py-4">
      {/* Type icon */}
      <div
        className={cn(
          "flex size-10 items-center justify-center rounded-xl sm:size-12",
          config.iconBg,
        )}
      >
        <Icon className={cn("size-4.5 sm:size-5", config.iconColor)} />
      </div>

      {/* Description + meta */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground sm:text-base">
          {transaction.description || transaction.payee || "Untitled"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">
          {subtitle}
        </p>
      </div>

      {/* Amount + date */}
      <div className="shrink-0 text-right">
        <p
          className={cn(
            "text-lg font-semibold tabular-nums sm:text-xl",
            isAdjustment
              ? signedAmount >= 0
                ? "text-emerald-500"
                : "text-destructive"
              : isTransfer
                ? "text-blue-500"
                : config.amountColor,
          )}
        >
          {isTransfer
            ? (isOutgoingTransfer ? "-" : "+")
            : signedAmount > 0
              ? "+"
              : signedAmount < 0
                ? "-"
                : ""}
          {formatCurrency(
            Math.abs(signedAmount),
            account?.currency ?? "USD",
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">
          {formatDate(transaction.date)}
        </p>
      </div>

      {/* Actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={`Open ${transaction.description || transaction.payee || "Untitled"} actions`}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {transaction.type !== "adjustment" && (
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 size-4" />
              Edit
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="mr-2 size-4" />
            Delete{isTransfer ? " transfer" : ""}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={isTransfer ? "Delete transfer" : "Delete transaction"}
        description={
          isTransfer
            ? "Delete this transfer? Both sides will be removed and account balances restored. This cannot be undone."
            : "Delete this transaction? This cannot be undone."
        }
        onConfirm={handleDelete}
      />
    </div>
    {deleteError && (
      <p role="alert" className="mt-2 px-3 text-sm text-destructive sm:px-5">
        {deleteError}
      </p>
    )}
    </div>
  );
}
