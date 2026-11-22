import { Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress-bar";
import type { GoalsProgressData } from "@/lib/mock-dashboard-data";
import { formatMinor as formatCurrency } from "@/lib/money";
import { CardStatusBody, showsStatus, type CardStatus } from "./card-error";

interface GoalsProgressCardProps {
  /** Amounts in minor units of `currency`. */
  data: GoalsProgressData;
  status?: CardStatus;
}

export function GoalsProgressCard({ data, status }: GoalsProgressCardProps) {
  if (showsStatus(status)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Savings Goals
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CardStatusBody status={status} />
        </CardContent>
      </Card>
    );
  }

  if (data.goals.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Savings Goals
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-3 text-center sm:min-h-36 sm:px-4">
            <p className="text-sm text-muted-foreground">
              Your savings goals will appear here once you create one.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Savings Goals
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:gap-4">
        {data.goals.map((goal) => {
          const progressColor =
            goal.percentComplete >= 80
              ? "bg-wise-positive"
              : goal.percentComplete >= 50
                ? "bg-wise-bright-green"
                : "bg-chart-2";

          return (
            <div key={goal.id} className="flex flex-col gap-1.5 sm:gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="inline-flex size-6 items-center justify-center rounded-lg bg-muted text-muted-foreground sm:size-7">
                    <Target className="size-3 sm:size-3.5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {goal.name}
                    </p>
                    {goal.targetDate && (
                      <p className="text-xs text-muted-foreground">
                        Due{" "}
                        {new Date(`${goal.targetDate}T00:00:00`).toLocaleDateString("en-US", {
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                    )}
                  </div>
                </div>
                <span className="text-xs font-semibold tabular-nums text-foreground sm:text-sm">
                  {goal.percentComplete}%
                </span>
              </div>
              <ProgressBar
                percent={goal.percentComplete}
                barColor={progressColor}
                className="h-3.5 sm:h-4"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {formatCurrency(goal.currentAmount, data.currency)} saved
                </span>
                <span>
                  {formatCurrency(goal.targetAmount, data.currency)} target
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
