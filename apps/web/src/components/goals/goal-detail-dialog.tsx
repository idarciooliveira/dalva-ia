import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Goal, GoalContribution } from "@mpf/finance-contract";
import { Archive, ArchiveRestore, Edit, PlusCircle, Trash2 } from "lucide-react";

import { ErrorState, FormError } from "@/components/error-state";
import { InlineConfirm } from "@/components/inline-confirm";
import { goalPercent, goalProgressColor } from "@/components/goals/goal-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { goalContributionsQuery } from "@/lib/api/queries";
import { formatMonthYear } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { formatMinor } from "@/lib/money";

interface GoalDetailDialogProps {
  goal: Goal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onContribute: () => void;
}

export function GoalDetailDialog({ goal, open, onOpenChange, onEdit, onContribute }: GoalDetailDialogProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const percent = goalPercent(goal);
  const currency = goal.targetAmount.currency;
  const remaining = Math.max(0, goal.targetAmount.amountMinor - goal.currentAmount.amountMinor);

  const contributions = useQuery({ ...goalContributionsQuery(goal.id), enabled: open });

  const close = () => onOpenChange(false);
  const { mutate: archiveGoal, isPending: archiving } = useApiMutation("goals", "archive", {
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (err) => setError(apiErrorMessage(err, "Couldn't archive the goal. Try again.")),
  });
  const { mutate: restoreGoal, isPending: restoring } = useApiMutation("goals", "restore", {
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (err) => setError(apiErrorMessage(err, "Couldn't restore the goal. Try again.")),
  });
  const { mutate: deleteGoal, isPending: deleting } = useApiMutation("goals", "delete", {
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (err) => setError(apiErrorMessage(err, "Couldn't delete the goal. Try again.")),
  });
  const busy = archiving || restoring || deleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">{goal.name}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {goal.archived ? "Archived" : goal.targetDate ? `Due ${formatMonthYear(goal.targetDate)}` : "No target date"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 px-4 pt-4 pb-4 sm:px-5">
          <div className="mb-1">
            <span className="text-2xl font-semibold tabular-nums text-foreground">{percent}%</span>
          </div>
          <ProgressBar percent={percent} barColor={goalProgressColor(percent)} className="h-3" />
          <div className="mt-2 mb-4 flex justify-between text-xs text-muted-foreground">
            <span className="tabular-nums">{formatMinor(goal.currentAmount.amountMinor, currency)} saved</span>
            <span className="tabular-nums">{formatMinor(remaining, currency)} to go</span>
          </div>

          <div className="mb-4 flex items-center gap-2 border-b border-border pb-4">
            {!goal.archived && (
              <Button variant="accent" className="flex-1" onClick={onContribute} disabled={busy}>
                <PlusCircle className="mr-1.5 size-4" aria-hidden="true" />
                Contribute
              </Button>
            )}
            <Button variant="outline" className="flex-1" onClick={onEdit} disabled={busy}>
              <Edit className="mr-1.5 size-4" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="outline"
              className="size-10 shrink-0 p-0"
              disabled={busy}
              onClick={() => (goal.archived ? restoreGoal({ id: goal.id }) : archiveGoal({ id: goal.id }))}
              aria-label={goal.archived ? "Restore goal" : "Archive goal"}
              title={goal.archived ? "Restore" : "Archive"}
            >
              {goal.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            </Button>
            <Button
              variant="destructive"
              className="size-10 shrink-0 p-0"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete goal"
              title="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          {confirmDelete && (
            <InlineConfirm
              message="Delete this goal and its contribution history? Transfers already made stay in your transactions. This cannot be undone."
              busy={deleting}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => deleteGoal({ id: goal.id })}
            />
          )}

          <FormError message={error} className="mt-0 mb-3" />

          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">Contributions</h4>
            {contributions.isPending ? (
              <div className="h-14 animate-pulse rounded-lg bg-muted/40" />
            ) : contributions.isError && !contributions.data ? (
              <ErrorState
                error={contributions.error}
                fallback="Couldn't load the contributions."
                onRetry={() => void contributions.refetch()}
                className="py-6 sm:py-6"
              />
            ) : contributions.data.items.length === 0 ? (
              <p className="pb-2 text-xs text-muted-foreground">No contributions yet.</p>
            ) : (
              <ul aria-label="Contributions" className="max-h-60 space-y-2 overflow-y-auto pb-2">
                {contributions.data.items.map((c) => (
                  <ContributionRow key={c.id} contribution={c} />
                ))}
              </ul>
            )}
          </div>
        </div>

      </DialogContent>
    </Dialog>
  );
}

function ContributionRow({ contribution }: { contribution: GoalContribution }) {
  const [error, setError] = useState<string | null>(null);
  const { mutate: remove, isPending } = useApiMutation("goalContributions", "remove", {
    onMutate: () => setError(null),
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove the contribution. Try again.")),
  });
  const amount = formatMinor(contribution.amount.amountMinor, contribution.amount.currency);

  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium tabular-nums text-foreground">{amount}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatDate(contribution.date)}
            {contribution.note && ` — ${contribution.note}`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          disabled={isPending}
          onClick={() => remove({ id: contribution.id })}
          aria-label={`Remove contribution of ${amount} on ${formatDate(contribution.date)}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <FormError message={error} className="mt-1 text-xs" />
    </li>
  );
}
