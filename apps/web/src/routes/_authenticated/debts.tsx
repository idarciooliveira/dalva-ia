import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Archive, CreditCard, Plus } from "lucide-react";
import { useState } from "react";

import { DebtCard } from "@/components/debts/debt-card";
import { DebtDetailDialog } from "@/components/debts/debt-detail-dialog";
import { DebtFormDialog } from "@/components/debts/debt-form-dialog";
import { DebtPaymentDialog } from "@/components/debts/debt-payment-dialog";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { debtSummaryQuery, debtsQuery } from "@/lib/api/queries";
import { formatMinor } from "@/lib/money";

export const Route = createFileRoute("/_authenticated/debts")({
  component: DebtsPage,
});

function DebtsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-200 px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
        <DebtsContent />
      </div>
    </div>
  );
}

function DebtsContent() {
  const [showArchived, setShowArchived] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  // Ids, not rows: the dialogs show the debt as the list has it now (after a payment, an edit).
  const [editDebtId, setEditDebtId] = useState<string | null>(null);
  const [paymentDebtId, setPaymentDebtId] = useState<string | null>(null);
  const [detailDebtId, setDetailDebtId] = useState<string | null>(null);

  const debtsResult = useQuery({
    ...debtsQuery({ includeArchived: showArchived }),
    placeholderData: keepPreviousData,
  });

  if (debtsResult.isPending) {
    return <DebtsListSkeleton />;
  }

  const debts = debtsResult.data?.items ?? [];
  const find = (id: string | null) => (id ? (debts.find((d) => d.id === id) ?? null) : null);
  const detailDebt = find(detailDebtId);
  const editDebt = find(editDebtId);
  const paymentDebt = find(paymentDebtId);

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Debts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Track balances, payments, and payoff progress across everything you owe.
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            variant={showArchived ? "secondary" : "outline"}
            size="default"
            onClick={() => setShowArchived(!showArchived)}
            aria-pressed={showArchived}
          >
            <Archive className="mr-1.5 size-4" aria-hidden="true" />
            Archived
          </Button>
          <Button variant="accent" size="default" className="flex-1 sm:flex-none" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-1.5 size-4" aria-hidden="true" />
            Add debt
          </Button>
        </div>
      </div>

      {debtsResult.isError && !debtsResult.data ? (
        <ErrorState error={debtsResult.error} fallback="Couldn't load your debts." onRetry={() => void debtsResult.refetch()} />
      ) : debts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 sm:py-16">
          <CreditCard className="mb-3 size-10 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">No debts yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Add a debt to track payoff progress and payment history.</p>
        </div>
      ) : (
        <>
          <DebtSummary />
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
            {debts.map((debt) => (
              <DebtCard key={debt.id} debt={debt} onClick={() => setDetailDebtId(debt.id)} />
            ))}
          </div>
        </>
      )}

      {detailDebt && (
        <DebtDetailDialog
          debt={detailDebt}
          open
          onOpenChange={(open) => {
            if (!open) setDetailDebtId(null);
          }}
          onEdit={() => {
            setEditDebtId(detailDebt.id);
            setDetailDebtId(null);
          }}
          onRecordPayment={() => {
            setPaymentDebtId(detailDebt.id);
            setDetailDebtId(null);
          }}
        />
      )}

      <DebtFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} debt={null} />
      <DebtFormDialog
        open={editDebt !== null}
        onOpenChange={(open) => {
          if (!open) setEditDebtId(null);
        }}
        debt={editDebt}
      />
      <DebtPaymentDialog
        open={paymentDebt !== null}
        onOpenChange={(open) => {
          if (!open) setPaymentDebtId(null);
        }}
        debt={paymentDebt}
      />
    </>
  );
}

/** Totals of the open (unarchived) debts. Hidden while loading, on error, or with nothing open. */
function DebtSummary() {
  const { data } = useQuery(debtSummaryQuery());
  if (!data || data.totalOriginal.amountMinor === 0) return null;

  const currency = data.totalOriginal.currency;
  const original = data.totalOriginal.amountMinor;
  const remaining = data.totalRemaining.amountMinor;
  const paid = Math.max(0, original - remaining);
  const tiles = [
    { label: "Remaining", value: formatMinor(remaining, currency) },
    { label: "Paid off", value: `${formatMinor(paid, currency)} · ${Math.round((paid / original) * 100)}%` },
    { label: "Last payment", value: data.recentPayment.amountMinor > 0 ? formatMinor(data.recentPayment.amountMinor, currency) : "None yet" },
  ];

  return (
    <dl aria-label="Debt summary" className="mb-4 grid grid-cols-1 gap-2 rounded-2xl border border-border bg-card p-4 sm:mb-6 sm:grid-cols-3 sm:gap-4 sm:p-5">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex items-baseline justify-between gap-3 sm:block">
          <dt className="text-xs text-muted-foreground sm:text-sm">{tile.label}</dt>
          <dd className="text-base font-semibold tabular-nums text-foreground sm:mt-1 sm:text-lg">{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DebtsListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="h-7 w-40 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-72 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-9 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3].map((item) => (
          <div key={item} className="h-34 animate-pulse rounded-2xl border border-border bg-muted/30" />
        ))}
      </div>
    </div>
  );
}
