import type { Debt } from "@mpf/finance-contract";
import { CreditCard } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { debtPercentPaid } from "@/lib/debts";
import { formatMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

interface DebtCardProps {
  debt: Debt;
  onClick?: () => void;
}

export function DebtCard({ debt, onClick }: DebtCardProps) {
  const percentPaid = debtPercentPaid(debt);
  const currency = debt.originalAmount.currency;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:p-5",
        debt.archived && "opacity-60",
      )}
    >
      <div className="flex flex-col gap-2.5 sm:gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <div className="inline-flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive sm:size-11">
              <CreditCard className="size-4.5 sm:size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground sm:text-base">{debt.name}</p>
                {debt.archived && (
                  <Badge variant="secondary" className="text-[10px]">
                    Archived
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">{debt.lender ?? "No lender"}</p>
            </div>
          </div>
          <span className="shrink-0 text-lg font-semibold tabular-nums text-foreground sm:text-xl">{percentPaid}%</span>
        </div>

        <ProgressBar percent={percentPaid} barColor="bg-wise-positive" />

        <div className="flex justify-between gap-3 text-xs text-muted-foreground sm:text-sm">
          <span>{formatMinor(debt.currentBalance.amountMinor, currency)} remaining</span>
          <span>{formatMinor(debt.originalAmount.amountMinor, currency)} original</span>
        </div>
      </div>
    </button>
  );
}
