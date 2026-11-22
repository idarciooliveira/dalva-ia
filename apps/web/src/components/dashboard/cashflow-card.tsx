import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cashflowQuery } from "@/lib/api/dashboard";
import { formatMinor, fractionDigits } from "@/lib/money";
import { CardError } from "./card-error";

/** Major units (the chart's scale) as a compact axis label: "$5K". */
function formatCompact(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0, notation: "compact" }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

const chartConfig = {
  income: {
    label: "Income",
    color: "var(--color-chart-1)",
  },
  expenses: {
    label: "Expenses",
    color: "var(--color-chart-3)",
  },
} satisfies ChartConfig;

interface CashflowCardProps {
  /** Month to display, e.g. "2026-04". */
  month: string;
  /** Number of trailing months for the trend chart (default 6). */
  trendMonths?: number;
}

export function CashflowCard({ month, trendMonths = 6 }: CashflowCardProps) {
  const { data, isPending, isError, error, refetch } = useQuery(cashflowQuery(month, trendMonths));

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Monthly Cashflow
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:gap-4">
          <div className="grid grid-cols-3 gap-3 sm:gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="aspect-[2/1] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Monthly Cashflow
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardError error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  const { income, expenses, net } = data.currentMonth;
  const currency = net.currency;
  const scale = 10 ** fractionDigits(currency);
  const isPositive = net.amountMinor >= 0;
  // The chart plots major units; every report amount is in the base currency.
  const chartData = data.trend.map((m) => ({
    month: m.month,
    income: m.income.amountMinor / scale,
    expenses: m.expenses.amountMinor / scale,
  }));
  const hasActivity = chartData.some((m) => m.income !== 0 || m.expenses !== 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Monthly Cashflow
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:gap-4">
        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-2.5 text-xs sm:gap-4 sm:text-sm">
          <div>
            <span className="text-xs text-muted-foreground">Income</span>
            <p className="flex items-center gap-1 text-xs font-medium text-foreground sm:text-sm">
              <ArrowUpRight className="size-3.5 text-wise-positive" />
              {formatMinor(income.amountMinor, currency)}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Expenses</span>
            <p className="flex items-center gap-1 text-xs font-medium text-foreground sm:text-sm">
              <ArrowDownRight className="size-3.5 text-destructive" />
              {formatMinor(expenses.amountMinor, currency)}
            </p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Net</span>
            <p
              className={`text-xs font-semibold sm:text-sm ${isPositive ? "text-wise-positive" : "text-destructive"}`}
            >
              {isPositive ? "+" : ""}
              {formatMinor(net.amountMinor, currency)}
            </p>
          </div>
        </div>

        {/* Bar chart */}
        {hasActivity ? (
          <ChartContainer
            config={chartConfig}
              className="aspect-[1.8/1] w-full sm:aspect-[2/1]"
            >
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                fontSize={12}
                tickFormatter={(value: number) => formatCompact(value, currency)}
                width={50}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => {
                      const label =
                        chartConfig[name as keyof typeof chartConfig]?.label ??
                        name;
                      return (
                        <span>
                          {label}:{" "}
                          {formatMinor(Math.round((value as number) * scale), currency)}
                        </span>
                      );
                    }}
                  />
                }
              />
              <Bar
                dataKey="income"
                fill="var(--color-income)"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="expenses"
                fill="var(--color-expenses)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No cashflow data yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
