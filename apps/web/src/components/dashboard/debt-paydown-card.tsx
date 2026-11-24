import { CreditCard } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import type { DebtPaydownData } from "@/lib/mock-dashboard-data";
import { formatMinor } from "@/lib/money";
import { CardStatusBody, showsStatus, type CardStatus } from "./card-error";

interface DebtPaydownCardProps {
  /** Amounts in minor units of `currency`. */
  data: DebtPaydownData;
  status?: CardStatus;
}

export function DebtPaydownCard({ data, status }: DebtPaydownCardProps) {
  if (showsStatus(status)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Debt Paydown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardStatusBody status={status} />
        </CardContent>
      </Card>
    );
  }

  if (data.debts.length === 0 || data.totalOriginal === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Debt Paydown
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No debts tracked yet.</p>
        </CardContent>
      </Card>
    );
  }

  const overallPercent = Math.round(
    ((data.totalOriginal - data.totalRemaining) / data.totalOriginal) * 100,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Debt Paydown
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:gap-4">
        {/* Overall progress */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
              {formatMinor(data.totalRemaining, data.currency)}
            </span>
            <span className="text-xs text-muted-foreground">
              {overallPercent}% paid off
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            remaining of {formatMinor(data.totalOriginal, data.currency)}
          </p>
          <ProgressBar percent={overallPercent} barColor="bg-wise-positive" className="mt-2" />
        </div>

        {/* Individual debts */}
        <div className="flex flex-col gap-2.5 sm:gap-3">
          {data.debts.map((debt) => (
            <div
              key={debt.id}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                <div className="inline-flex size-7 items-center justify-center rounded-lg bg-destructive/10 text-destructive sm:size-8">
                  <CreditCard className="size-3.5 sm:size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {debt.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {debt.creditor}
                  </p>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium tabular-nums text-foreground">
                  {formatMinor(debt.currentBalance, data.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {debt.percentPaid}% paid
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Last payment */}
        <div className="rounded-lg bg-muted px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Last payment:{" "}
            <span className="font-medium text-foreground">
              {formatMinor(data.recentPayment, data.currency)}
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
