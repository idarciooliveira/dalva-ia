import { useQuery } from "@tanstack/react-query";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { spendingByCategoryQuery } from "@/lib/api/dashboard";
import { formatMinor, fractionDigits } from "@/lib/money";
import { CardError } from "./card-error";

/* -------------------------------------------------------------------------- */
/*  Chart color palette                                                       */
/* -------------------------------------------------------------------------- */

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-muted-foreground)",
];

function getColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]!;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

interface SpendingCategoryCardProps {
  /** Month to display, e.g. "2026-04". */
  month: string;
}

export function SpendingCategoryCard({ month }: SpendingCategoryCardProps) {
  const { data, isPending, isError, error, refetch } = useQuery(spendingByCategoryQuery(month));

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Spending by Category
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3 sm:gap-4">
          <Skeleton className="size-[144px] rounded-full sm:size-[160px]" />
          <div className="w-full space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Spending by Category
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardError error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  const currency = data.total.currency;
  const scale = 10 ** fractionDigits(currency);
  const total = data.total.amountMinor;
  const categories = data.categories.map((cat) => ({
    key: cat.categoryId ?? "uncategorized",
    name: cat.name,
    amount: cat.amount.amountMinor,
  }));

  if (categories.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Spending by Category
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">
            No expenses recorded this month.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Assign colors and build chart data
  const coloredCategories = categories.map((cat, i) => ({
    ...cat,
    fill: getColor(i),
  }));

  // Build chart config from categories
  const chartConfig: ChartConfig = {};
  for (const cat of coloredCategories) {
    chartConfig[cat.name] = {
      label: cat.name,
      color: cat.fill,
    };
  }

  // The chart plots major units.
  const chartData = coloredCategories.map((cat) => ({
    key: cat.key,
    name: cat.name,
    value: cat.amount / scale,
    fill: cat.fill,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Spending by Category
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:gap-4">
        {/* Donut chart */}
        <ChartContainer
          config={chartConfig}
          className="mx-auto aspect-square w-full max-w-[170px] sm:max-w-[200px]"
        >
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
                innerRadius={42}
                outerRadius={68}
              strokeWidth={2}
              stroke="var(--color-card)"
            >
              {chartData.map((entry) => (
                <Cell key={entry.key} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const item = payload[0];
                return (
                  <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <div className="flex items-center gap-2">
                      <div
                        className="size-2 rounded-[2px]"
                        style={{ backgroundColor: item.payload?.fill }}
                      />
                      <span className="text-muted-foreground">
                        {item.name}
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatMinor(Math.round((item.value as number) * scale), currency)}
                      </span>
                    </div>
                  </div>
                );
              }}
            />
          </PieChart>
        </ChartContainer>

        {/* Legend list */}
        <div className="flex flex-col gap-1.5 sm:gap-2">
          {coloredCategories.map((cat) => {
            const pct = total > 0 ? Math.round((cat.amount / total) * 100) : 0;
            return (
              <div
                key={cat.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  <div
                    className="size-2.5 rounded-[2px]"
                    style={{ backgroundColor: cat.fill }}
                  />
                  <span className="truncate text-muted-foreground">{cat.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                  <span className="text-sm font-medium tabular-nums text-foreground">
                    {formatMinor(cat.amount, currency)}
                  </span>
                  <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                    {pct}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
