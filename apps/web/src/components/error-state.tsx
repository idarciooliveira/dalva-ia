import { AlertCircle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  error: unknown;
  /** Shown when the error carries no user-facing message. */
  fallback?: string;
  onRetry?: () => void;
  /** A way out when retrying can't help (e.g. the profile keeps failing). */
  onSignOut?: () => void;
  className?: string;
}

/** Inline failure of a page's data, with a retry. Same footprint as the list empty states. */
export function ErrorState({ error, fallback, onRetry, onSignOut, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-destructive/40 px-4 py-12 text-center sm:py-16",
        className,
      )}
    >
      <AlertCircle className="mb-3 size-10 text-destructive/70" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{apiErrorMessage(error, fallback)}</p>
      {(onRetry || onSignOut) && (
        <div className="mt-4 flex gap-2">
          {onRetry && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
          )}
          {onSignOut && (
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Full-screen variant for the auth guard: the session or profile couldn't be read. */
export function FullPageError(props: ErrorStateProps) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6">
      <ErrorState {...props} className={cn("w-full max-w-md", props.className)} />
    </div>
  );
}

/** A write's failure inside a dialog or below a row. */
export function FormError({
  message,
  className,
  id,
}: {
  message: string | null | undefined;
  className?: string;
  /** For `aria-describedby` on the field it is about. */
  id?: string;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className={cn("mt-3 text-sm text-destructive", className)}>
      {message}
    </p>
  );
}
