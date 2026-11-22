import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Archive, Plus, Target } from "lucide-react";

import { ErrorState } from "@/components/error-state";
import { ContributionDialog } from "@/components/goals/contribution-dialog";
import { GoalCard } from "@/components/goals/goal-card";
import { GoalDetailDialog } from "@/components/goals/goal-detail-dialog";
import { GoalFormDialog } from "@/components/goals/goal-form-dialog";
import { Button } from "@/components/ui/button";
import { goalsQuery } from "@/lib/api/queries";

export const Route = createFileRoute("/_authenticated/goals")({
  component: GoalsPage,
});

function GoalsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-200 px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
        <GoalsContent />
      </div>
    </div>
  );
}

function GoalsContent() {
  const [showArchived, setShowArchived] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  // Ids, not rows: the dialogs show the goal as the list has it now (after a contribution, an edit).
  const [editGoalId, setEditGoalId] = useState<string | null>(null);
  const [contributeGoalId, setContributeGoalId] = useState<string | null>(null);
  const [detailGoalId, setDetailGoalId] = useState<string | null>(null);

  const goalsResult = useQuery({
    ...goalsQuery({ includeArchived: showArchived }),
    placeholderData: keepPreviousData,
  });

  if (goalsResult.isPending) {
    return <GoalsListSkeleton />;
  }

  const goals = goalsResult.data?.items ?? [];
  const find = (id: string | null) => (id ? (goals.find((g) => g.id === id) ?? null) : null);
  const detailGoal = find(detailGoalId);
  const editGoal = find(editGoalId);
  const contributeGoal = find(contributeGoalId);

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Savings Goals</h2>
          <p className="mt-1 text-sm text-muted-foreground">Track your savings progress and contributions.</p>
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
            Add goal
          </Button>
        </div>
      </div>

      {goalsResult.isError && !goalsResult.data ? (
        <ErrorState
          error={goalsResult.error}
          fallback="Couldn't load your goals."
          onRetry={() => void goalsResult.refetch()}
        />
      ) : goals.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 sm:py-16">
          <Target className="mb-3 size-10 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">No savings goals yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Create your first goal to start saving toward something.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
          {goals.map((goal) => (
            <GoalCard key={goal.id} goal={goal} onClick={() => setDetailGoalId(goal.id)} />
          ))}
        </div>
      )}

      {detailGoal && (
        <GoalDetailDialog
          goal={detailGoal}
          open
          onOpenChange={(open) => {
            if (!open) setDetailGoalId(null);
          }}
          onEdit={() => {
            setEditGoalId(detailGoal.id);
            setDetailGoalId(null);
          }}
          onContribute={() => {
            setContributeGoalId(detailGoal.id);
            setDetailGoalId(null);
          }}
        />
      )}

      <GoalFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} goal={null} />
      <GoalFormDialog
        open={editGoal !== null}
        onOpenChange={(open) => {
          if (!open) setEditGoalId(null);
        }}
        goal={editGoal}
      />

      <ContributionDialog
        open={contributeGoal !== null}
        onOpenChange={(open) => {
          if (!open) setContributeGoalId(null);
        }}
        goal={contributeGoal}
      />
    </>
  );
}

function GoalsListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="h-7 w-40 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-4 w-64 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-9 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-34 animate-pulse rounded-2xl border border-border bg-muted/30" />
        ))}
      </div>
    </div>
  );
}
