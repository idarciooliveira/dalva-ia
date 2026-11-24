import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A dashboard card whose data failed to load: the reason and a retry, inside the
 * card. Reports in several currencies come back as `conflict` with their own message.
 */
export function CardError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <ErrorState
      error={error}
      fallback="Couldn't load this card. Try again."
      onRetry={onRetry}
      className="min-h-32 rounded-xl py-0 sm:min-h-36 sm:py-0"
    />
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

/** Whether the card should render `CardStatusBody` instead of its data. */
export const showsStatus = (status: CardStatus | undefined): status is CardStatus =>
  !!status && (status.loading || !!status.error);

/** The error, else the skeleton, for a card whose `showsStatus` is true. */
export function CardStatusBody({ status }: { status: CardStatus }) {
  if (status.error) return <CardError error={status.error} onRetry={status.onRetry} />;
  return (
    <div role="status" className="flex min-h-32 flex-col justify-center gap-3 sm:min-h-36" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}
