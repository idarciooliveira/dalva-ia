import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Debt, DebtPayment } from "@mpf/finance-contract";
import { Archive, ArchiveRestore, Edit, Plus, Trash2 } from "lucide-react";

import { ErrorState, FormError } from "@/components/error-state";
import { InlineConfirm } from "@/components/inline-confirm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { debtPaymentsQuery } from "@/lib/api/queries";
import { debtPercentPaid, debtTypeLabel } from "@/lib/debts";
import { formatDate } from "@/lib/format";
import { formatMinor } from "@/lib/money";

interface DebtDetailDialogProps {
  debt: Debt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onRecordPayment: () => void;
}

export function DebtDetailDialog({ debt, open, onOpenChange, onEdit, onRecordPayment }: DebtDetailDialogProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const percentPaid = debtPercentPaid(debt);
  const currency = debt.originalAmount.currency;

  const close = () => onOpenChange(false);
  const { mutate: archiveDebt, isPending: archiving } = useApiMutation("debts", "archive", {
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (err) => setError(apiErrorMessage(err, "Couldn't archive the debt. Try again.")),
  });
  const { mutate: restoreDebt, isPending: restoring } = useApiMutation("debts", "restore", {
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (err) => setError(apiErrorMessage(err, "Couldn't restore the debt. Try again.")),
  });
  const { mutate: deleteDebt, isPending: deleting } = useApiMutation("debts", "delete", {
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (err) => setError(apiErrorMessage(err, "Couldn't delete the debt. Try again.")),
  });
  const busy = archiving || restoring || deleting;
  // Not while deleting: the delete invalidates the debts prefix, and this list would refetch a 404.
  const payments = useQuery({ ...debtPaymentsQuery(debt.id), enabled: open && !deleting });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">{debt.name}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {debt.lender ?? "No lender"}
            {debt.dueDate ? ` - due ${formatDate(debt.dueDate)}` : ""}
            {debt.archived ? " - archived" : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 px-4 pt-4 pb-4 sm:px-5">
          <div className="mb-1">
            <span className="text-2xl font-semibold tabular-nums text-foreground">{percentPaid}%</span>
          </div>
          <ProgressBar percent={percentPaid} barColor="bg-wise-positive" className="h-3" />
          <div className="mt-2 mb-4 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:gap-3">
            <span className="tabular-nums">{formatMinor(debt.currentBalance.amountMinor, currency)} remaining</span>
            <span className="tabular-nums sm:text-right">{formatMinor(debt.originalAmount.amountMinor, currency)} original</span>
          </div>

          <dl className="mb-4 grid gap-2 rounded-lg bg-muted/40 p-3 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Type</dt>
              <dd className="min-w-0 text-right font-medium text-foreground">{debtTypeLabel(debt.debtType)}</dd>
            </div>
            {debt.minimumPayment && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Minimum</dt>
                <dd className="min-w-0 text-right font-medium text-foreground">
                  {formatMinor(debt.minimumPayment.amountMinor, debt.minimumPayment.currency)}
                </dd>
              </div>
            )}
            {debt.interestRate !== undefined && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">APR</dt>
                <dd className="min-w-0 text-right font-medium text-foreground">{debt.interestRate}%</dd>
              </div>
            )}
          </dl>

          <div className="mb-4 grid gap-2 border-b border-border pb-4 sm:grid-cols-2">
            {!debt.archived && (
              <Button variant="accent" className="w-full" onClick={onRecordPayment} disabled={busy}>
                <Plus className="mr-1.5 size-4" aria-hidden="true" />
                Record payment
              </Button>
            )}
            <Button variant="outline" className="w-full" onClick={onEdit} disabled={busy}>
              <Edit className="mr-1.5 size-4" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => (debt.archived ? restoreDebt({ id: debt.id }) : archiveDebt({ id: debt.id }))}
            >
              {debt.archived ? (
                <ArchiveRestore className="mr-1.5 size-4" aria-hidden="true" />
              ) : (
                <Archive className="mr-1.5 size-4" aria-hidden="true" />
              )}
              {debt.archived ? "Restore" : "Archive"}
            </Button>
            <Button variant="destructive" className="w-full" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1.5 size-4" aria-hidden="true" />
              Delete
            </Button>
          </div>

          {confirmDelete && (
            <InlineConfirm
              message="Delete this debt and its payments? The payment transactions are deleted and their effect on your account balances is reversed. This cannot be undone."
              busy={deleting}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => deleteDebt({ id: debt.id })}
            />
          )}

          <FormError message={error} className="mt-0 mb-3" />

          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">Payment history</h4>
            {payments.isPending ? (
              <div className="h-14 animate-pulse rounded-lg bg-muted/40" />
            ) : payments.isError && !payments.data ? (
              <ErrorState
                error={payments.error}
                fallback="Couldn't load the payments."
                onRetry={() => void payments.refetch()}
                className="py-6 sm:py-6"
              />
            ) : payments.data.items.length === 0 ? (
              <p className="pb-2 text-xs text-muted-foreground">No payments yet.</p>
            ) : (
              <ul aria-label="Payments" className="max-h-60 space-y-2 overflow-y-auto pb-2">
                {payments.data.items.map((payment) => (
                  <PaymentRow key={payment.id} payment={payment} />
                ))}
              </ul>
            )}
          </div>
        </div>

      </DialogContent>
    </Dialog>
  );
}

function PaymentRow({ payment }: { payment: DebtPayment }) {
  const [error, setError] = useState<string | null>(null);
  const { mutate: remove, isPending } = useApiMutation("debtPayments", "remove", {
    onMutate: () => setError(null),
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove the payment. Try again.")),
  });
  const amount = formatMinor(payment.amount.amountMinor, payment.amount.currency);
  const interest = payment.interestAmount.amountMinor;

  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium tabular-nums text-foreground">{amount}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatDate(payment.date)}
            {interest > 0 && ` - ${formatMinor(interest, payment.interestAmount.currency)} interest`}
            {payment.note ? ` - ${payment.note}` : ""}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          disabled={isPending}
          onClick={() => remove({ id: payment.id })}
          aria-label={`Remove payment of ${amount} on ${formatDate(payment.date)}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <FormError message={error} className="mt-1 text-xs" />
    </li>
  );
}
