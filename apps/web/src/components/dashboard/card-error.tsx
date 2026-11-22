import { AlertCircle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api/errors";

/**
 * A dashboard card whose data failed to load: the reason and a retry, inside the
 * card. Reports in several currencies come back as `conflict` with their own message.
 */
export function CardError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/40 px-3 text-center sm:min-h-36 sm:px-4"
    >
      <p className="flex items-center gap-2 text-sm text-foreground">
        <AlertCircle className="size-4 shrink-0 text-destructive/70" aria-hidden="true" />
        {apiErrorMessage(error, "Couldn't load this card. Try again.")}
      </p>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
        <RotateCw className="size-3.5" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}

/** What a card shows instead of its data: a skeleton while loading, the error after a failure. */
export interface CardStatus {
  loading: boolean;
  /** Set only when there is no data to show. */
  error: unknown;
  onRetry: () => void;
}

/** A card status from a query result: cached data stays visible through a failed refetch. */
export function cardStatus(query: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
  refetch: () => unknown;
}): CardStatus {
  return {
    loading: query.isPending,
    error: query.isError && query.data === undefined ? query.error : null,
    onRetry: () => void query.refetch(),
  };
}

/** The skeleton or the error for a card's content, or null when it has data to render. */
export function CardStatusBody({ status }: { status?: CardStatus }) {
  if (!status) return null;
  if (status.error) return <CardError error={status.error} onRetry={status.onRetry} />;
  if (status.loading) {
    return (
      <div className="flex min-h-32 flex-col justify-center gap-3 sm:min-h-36" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  return null;
}

/** Whether the card should render `CardStatusBody` instead of its data. */
export const showsStatus = (status: CardStatus | undefined): status is CardStatus =>
  !!status && (status.loading || !!status.error);
