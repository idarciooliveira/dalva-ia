import { Button } from "@/components/ui/button";

interface InlineConfirmProps {
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A destructive confirmation inside an open dialog, in place of a second modal
 * (a nested alert dialog would dismiss the dialog under it).
 */
export function InlineConfirm({ message, confirmLabel = "Yes, delete", busy, onCancel, onConfirm }: InlineConfirmProps) {
  return (
    <div role="group" aria-label="Confirm delete" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-sm text-foreground">{message}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy} autoFocus>
          No
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting..." : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
