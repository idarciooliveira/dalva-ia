import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Scale,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { RecentTransactionItem } from "@/lib/dashboard-data";
import { formatDate } from "@/lib/format";
import { formatMinor } from "@/lib/money";
import { CardStatusBody, showsStatus, type CardStatus } from "./card-error";

interface RecentTransactionsCardProps {
  transactions: RecentTransactionItem[];
  status?: CardStatus;
}

const typeIcons = {
  income: ArrowUpRight,
  expense: ArrowDownRight,
  adjustment: Scale,
  transfer: ArrowLeftRight,
} as const;

const typeColors = {
  income: "text-emerald-500 bg-emerald-500/10",
  expense: "text-destructive bg-destructive/10",
  adjustment: "text-primary bg-primary/10",
  transfer: "text-muted-foreground bg-muted",
} as const;

export function RecentTransactionsCard({ transactions, status }: RecentTransactionsCardProps) {
  if (showsStatus(status) || transactions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Recent Transactions
          </CardTitle>
          <CardAction>
            <Button variant="link" size="sm" className="text-xs" asChild>
              <Link to="/transactions">View all</Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {showsStatus(status) ? (
            <CardStatusBody status={status} />
          ) : (
            <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-3 text-center sm:min-h-36 sm:px-4">
              <p className="text-sm text-muted-foreground">
                Your latest transactions will appear here once you add a record.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Recent Transactions
        </CardTitle>
        <CardAction>
          <Button variant="link" size="sm" className="text-xs" asChild>
            <Link to="/transactions">View all</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col divide-y divide-border">
          {transactions.map((txn) => {
            const Icon = typeIcons[txn.type];
            const colorClass = typeColors[txn.type];
            const isPositive = txn.amountMinor > 0;

            return (
              <div
                key={txn.id}
                className="flex items-center justify-between gap-2.5 py-2.5 first:pt-0 last:pb-0 sm:gap-3 sm:py-3"
              >
                <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                  <div
                    className={`inline-flex size-7 items-center justify-center rounded-lg sm:size-8 ${colorClass}`}
                  >
                    <Icon className="size-3.5 sm:size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {txn.description}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {txn.category} &middot; {txn.account}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`text-sm font-medium tabular-nums ${
                      txn.type === "transfer"
                        ? "text-muted-foreground"
                        : isPositive
                          ? "text-emerald-500"
                          : "text-red-500"
                    }`}
                  >
                    {isPositive ? "+" : txn.amountMinor < 0 ? "-" : ""}
                    {formatMinor(Math.abs(txn.amountMinor), txn.currency)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(txn.date)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
