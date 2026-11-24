import { useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { TransactionListItem, TransactionManagedBy } from "@mpf/finance-contract";
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Scale,
  MoreVertical,
  Pencil,
  Trash2,
  Target,
  CreditCard,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { FormError } from "@/components/error-state";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";
import { isOutgoing, transactionTitle } from "@/lib/dashboard-data";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { formatMinor } from "@/lib/money";

interface TransactionRowProps {
  transaction: TransactionListItem;
  /** Account and category names by id (archived ones included). */
  accountNames: ReadonlyMap<string, string>;
  categoryNames: ReadonlyMap<string, string>;
  /** Edit an income or expense row. */
  onEdit: () => void;
  /** Edit the transfer this row is a leg of. */
  onEditTransfer: () => void;
}

const typeConfig = {
  income: { icon: ArrowUpRight, iconColor: "text-emerald-500", iconBg: "bg-emerald-500/10", amountColor: "text-emerald-500" },
  expense: { icon: ArrowDownRight, iconColor: "text-destructive", iconBg: "bg-destructive/10", amountColor: "text-destructive" },
  adjustment: { icon: Scale, iconColor: "text-primary", iconBg: "bg-primary/10", amountColor: "text-primary" },
  transfer: { icon: ArrowLeftRight, iconColor: "text-blue-500", iconBg: "bg-blue-500/10", amountColor: "text-blue-500" },
} as const;

/** Rows another flow owns: where to change them instead. */
const OWNED_ELSEWHERE: Record<Exclude<TransactionManagedBy, "transfer">, { label: string; to: "/goals" | "/debts"; cta: string }> = {
  goal_contribution: { label: "Part of a savings goal contribution", to: "/goals", cta: "Manage in Goals" },
  debt_payment: { label: "Part of a debt payment", to: "/debts", cta: "Manage in Debts" },
};

/** Which flow owns the row. Older servers don't send `managedBy`: a transfer leg is still a transfer. */
function managedByOf(transaction: TransactionListItem): TransactionManagedBy | undefined {
  return transaction.managedBy ?? (transaction.type === "transfer" ? "transfer" : undefined);
}

export function TransactionRow({ transaction, accountNames, categoryNames, onEdit, onEditTransfer }: TransactionRowProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const ownerNoteId = useId();

  const config = typeConfig[transaction.type];
  const Icon = config.icon;
  const managedBy = managedByOf(transaction);
  const isTransfer = managedBy === "transfer";
  const ownedElsewhere = managedBy && managedBy !== "transfer" ? OWNED_ELSEWHERE[managedBy] : null;
  const isAdjustment = transaction.type === "adjustment";
  const title = transactionTitle(transaction);

  // A row already deleted elsewhere (`not_found`) refreshes the list through useApiMutation.
  const onError = (fallback: string) => (error: Error) => setDeleteError(apiErrorMessage(error, fallback));
  const deleteTransaction = useApiMutation("transactions", "delete", {
    onMutate: () => setDeleteError(null),
    onError: onError("Couldn't delete the transaction. Try again."),
  });
  const deleteTransfer = useApiMutation("transfers", "delete", {
    onMutate: () => setDeleteError(null),
    onError: onError("Couldn't delete the transfer. Try again."),
  });
  const isDeleting = deleteTransaction.isPending || deleteTransfer.isPending;

  const account = accountNames.get(transaction.accountId) ?? "Unknown account";
  const outgoing = isOutgoing(transaction);
  let subtitle: string;
  if (transaction.type === "transfer") {
    subtitle = outgoing
      ? `${account}  →  ${accountNames.get(transaction.destinationAccountId ?? "") ?? "Unknown account"}`
      : `Transfer to ${account}`;
  } else if (isAdjustment) {
    subtitle = `Adjustment · ${account}`;
  } else {
    subtitle = `${categoryNames.get(transaction.categoryId ?? "") ?? "Uncategorized"} · ${account}`;
  }

  const amountMinor = transaction.amount.amountMinor;
  // Adjustments carry their own sign; the rest are positive amounts in a direction.
  const sign = outgoing || amountMinor < 0 ? "-" : amountMinor > 0 ? "+" : "";
  const amountColor = isAdjustment ? (amountMinor >= 0 ? "text-emerald-500" : "text-destructive") : config.amountColor;

  function handleDelete() {
    if (isTransfer) deleteTransfer.mutate({ id: transaction.id });
    else deleteTransaction.mutate({ id: transaction.id });
  }

  return (
    <div role="listitem" aria-label={title}>
      <div className="flex min-h-20 items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-3.5 transition-colors sm:min-h-22 sm:gap-5 sm:px-5 sm:py-4">
        {/* Type icon */}
        <div className={cn("flex size-10 items-center justify-center rounded-xl sm:size-12", config.iconBg)} aria-hidden="true">
          <Icon className={cn("size-4.5 sm:size-5", config.iconColor)} />
        </div>

        {/* Description + meta */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground sm:text-base">{title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground sm:mt-1 sm:text-sm">{subtitle}</p>
        </div>

        {/* Amount + date */}
        <div className="shrink-0 text-right">
          <p className={cn("text-lg font-semibold tabular-nums sm:text-xl", amountColor)}>
            {sign}
            {formatMinor(Math.abs(amountMinor), transaction.amount.currency)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">{formatDate(transaction.date)}</p>
        </div>

        {/* Actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={`Open ${title} actions`}
              disabled={isDeleting}
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {ownedElsewhere ? (
              <>
                <DropdownMenuLabel id={ownerNoteId} className="max-w-56 text-xs font-normal text-muted-foreground">
                  {ownedElsewhere.label}. Edit or delete it there.
                </DropdownMenuLabel>
                <DropdownMenuItem asChild aria-describedby={ownerNoteId}>
                  <Link to={ownedElsewhere.to}>
                    {managedBy === "goal_contribution" ? (
                      <Target className="mr-2 size-4" />
                    ) : (
                      <CreditCard className="mr-2 size-4" />
                    )}
                    {ownedElsewhere.cta}
                  </Link>
                </DropdownMenuItem>
              </>
            ) : (
              <>
                {/* Adjustments are made from the account's "Adjust balance". */}
                {!isAdjustment && (
                  <DropdownMenuItem onClick={isTransfer ? onEditTransfer : onEdit}>
                    <Pencil className="mr-2 size-4" />
                    Edit{isTransfer ? " transfer" : ""}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete{isTransfer ? " transfer" : ""}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <ConfirmDeleteDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title={isTransfer ? "Delete transfer" : "Delete transaction"}
          description={
            isTransfer
              ? "Delete this transfer? Both sides will be removed and account balances restored. This cannot be undone."
              : "Delete this transaction? Its account balance will be restored. This cannot be undone."
          }
          onConfirm={handleDelete}
        />
      </div>
      <FormError message={deleteError} className="mt-2 px-3 sm:px-5" />
    </div>
  );
}
