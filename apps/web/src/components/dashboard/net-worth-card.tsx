import { Wallet } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { NetWorthData } from "@/lib/mock-dashboard-data";
import { formatMinor as formatCurrency } from "@/lib/money";
import { CardStatusBody, showsStatus, type CardStatus } from "./card-error";

interface NetWorthCardProps {
  /** Amounts in minor units of `currency`. */
  data: NetWorthData;
  status?: CardStatus;
}

export function NetWorthCard({ data, status }: NetWorthCardProps) {
  if (showsStatus(status)) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Wallet className="size-4" />
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net Worth
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <CardStatusBody status={status} />
        </CardContent>
      </Card>
    );
  }

  if (!data.hasData) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Wallet className="size-4" />
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net Worth
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-3 text-center sm:min-h-36 sm:px-4">
            <p className="text-sm text-muted-foreground">
              Your net worth will appear here once you add an account or debt.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Wallet className="size-4" />
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Net Worth
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {formatCurrency(data.netWorth, data.currency)}
          </span>
        </div>
        <div className="flex gap-4 text-sm sm:gap-6">
          <div>
            <span className="text-muted-foreground">Assets</span>
            <p className="font-medium text-foreground">
              {formatCurrency(data.totalAssets, data.currency)}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">Debts</span>
            <p className="font-medium text-destructive">
              {formatCurrency(data.totalDebts, data.currency)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
