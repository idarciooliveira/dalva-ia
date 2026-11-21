import { useEffect, useState } from "react";
import type { Account } from "@mpf/finance-contract";
import { Landmark } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CurrencyInput, parseCurrencyInput } from "@/components/ui/currency-input";
import { FormError } from "@/components/error-state";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";
import { formatMinor, fractionDigits } from "@/lib/money";
import { getCurrencySymbol } from "@/lib/currencies";

interface AdjustBalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: Account | null;
}

export function AdjustBalanceDialog({
  open,
  onOpenChange,
  account,
}: AdjustBalanceDialogProps) {
  const [newBalance, setNewBalance] = useState("");
  const [adjustmentDate, setAdjustmentDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const { mutateAsync: adjustBalance, isPending } = useApiMutation("accounts", "adjust");

  // Reset each time the dialog opens (the parent opens it through `open`).
  useEffect(() => {
    if (!open) return;
    setNewBalance(account ? String(account.balance.amountMinor) : "");
    setAdjustmentDate(localToday());
    setNote("");
    setError("");
  }, [open, account]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!account || isPending) return;

    setError("");
    const newMinor = parseCurrencyInput(newBalance);
    if (Number.isNaN(newMinor)) {
      setError("Please enter a valid amount");
      return;
    }

    const delta = newMinor - account.balance.amountMinor;
    if (delta === 0) {
      onOpenChange(false);
      return;
    }

    try {
      await adjustBalance({
        id: account.id,
        amount: { amountMinor: delta, currency: account.balance.currency },
        date: adjustmentDate || undefined,
        note: note.trim() || undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't adjust the balance. Try again."));
    }
  }

  if (!account) return null;

  const currency = account.balance.currency;
  const currencySymbol = getCurrencySymbol(currency);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-lg font-semibold">
            Adjust balance
          </DialogTitle>
          <DialogDescription className="sr-only">
            Set the new balance; the difference is recorded as an adjustment.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="px-5 pt-4 pb-0">
            <div className="mb-5">
              <div className="flex items-baseline gap-1 border-b-2 border-primary pb-2">
                <span className="text-2xl font-semibold text-primary">
                  {currencySymbol}
                </span>
                <CurrencyInput
                  id="new-balance"
                  value={newBalance}
                  onValueChange={setNewBalance}
                  fractionDigits={fractionDigits(currency)}
                  allowNegative
                  placeholder="0,00"
                  autoFocus
                  className="flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                  aria-label="New balance"
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Current balance:{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {formatMinor(account.balance.amountMinor, currency)}
                </span>
              </p>
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <Landmark className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm text-foreground">{account.name}</p>
                <p className="text-xs text-muted-foreground capitalize">
                  {account.type} account
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <span className="w-5 shrink-0 text-center text-sm text-muted-foreground">
                #
              </span>
              <input
                id="adjustment-date"
                type="date"
                value={adjustmentDate}
                onChange={(e) => setAdjustmentDate(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground outline-none"
                aria-label="Adjustment date"
              />
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <span className="w-5 shrink-0 text-center text-sm text-muted-foreground">
                +
              </span>
              <input
                id="adjustment-note"
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Reason for this adjustment"
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                aria-label="Adjustment note"
              />
            </div>

            <FormError message={error} />
          </div>

          <div className="mt-2 flex items-center justify-end gap-3 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              size="default"
              className="flex-1 sm:flex-none"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="accent"
              size="default"
              className="flex-1 sm:flex-none"
              disabled={isPending || !newBalance.trim()}
            >
              {isPending ? "Saving..." : "Adjust balance"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Today in the user's time zone, `YYYY-MM-DD` (toISOString would give the UTC date). */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
