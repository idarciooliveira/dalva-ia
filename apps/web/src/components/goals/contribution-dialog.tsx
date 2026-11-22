import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@mpf/finance-contract";
import { Calendar, FileText, Wallet } from "lucide-react";

import { AccountPickerHint } from "@/components/account-picker-hint";
import { FormError } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CurrencyInput, parseCurrencyInput } from "@/components/ui/currency-input";
import { accountsForBaseCurrency } from "@/lib/accounts";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { accountsQuery } from "@/lib/api/queries";
import { getCurrencySymbol } from "@/lib/currencies";
import { localToday } from "@/lib/dates";
import { formatMinor, fractionDigits, maskPlaceholder } from "@/lib/money";

interface ContributionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal: Goal | null;
}

const ERROR_ID = "contribution-error";

export function ContributionDialog({ open, onOpenChange, goal }: ContributionDialogProps) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(localToday);
  const [note, setNote] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [error, setError] = useState("");

  const linked = goal !== null && !goal.isVirtual;
  const currency = goal?.targetAmount.currency ?? "USD";
  const digits = fractionDigits(currency);

  // A contribution to an account-linked goal is a transfer from another account in the base currency.
  const accountsResult = useQuery({ ...accountsQuery(), enabled: open && linked });
  const { usable, otherCurrency } = accountsForBaseCurrency(accountsResult.data?.items ?? [], currency);
  const sourceAccounts = usable.filter((a) => a.id !== goal?.linkedAccountId);

  const goalId = goal?.id;
  useEffect(() => {
    if (!open) return;
    setAmount("");
    setDate(localToday());
    setNote("");
    setFromAccountId("");
    setError("");
  }, [open, goalId]);

  const { mutateAsync: addContribution, isPending } = useApiMutation("goalContributions", "add");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!goal || isPending) return;
    setError("");

    const amountMinor = parseCurrencyInput(amount);
    if (Number.isNaN(amountMinor) || amountMinor <= 0) {
      setError("Please enter a valid amount");
      return;
    }
    if (linked && !fromAccountId) {
      setError("Please select a source account");
      return;
    }

    try {
      await addContribution({
        goalId: goal.id,
        amount: { amountMinor, currency },
        date: date || localToday(),
        note: note.trim() || undefined,
        // Virtual goals take no account (the API refuses one).
        fromAccountId: linked ? fromAccountId : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't add the contribution. Try again."));
    }
  }

  const remaining = goal ? Math.max(0, goal.targetAmount.amountMinor - goal.currentAmount.amountMinor) : 0;
  const invalidProps = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? ERROR_ID : undefined,
  } as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">Add contribution</DialogTitle>
          {goal ? (
            <DialogDescription className="mt-0.5 text-sm text-muted-foreground">
              {goal.name} &mdash; {formatMinor(remaining, currency)} remaining
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">Add money to the goal.</DialogDescription>
          )}
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
            <div className="mb-5">
              <div className="flex items-baseline gap-1 border-b-2 border-primary pb-2">
                <span className="text-2xl font-semibold text-primary">{getCurrencySymbol(currency)}</span>
                <CurrencyInput
                  value={amount}
                  onValueChange={setAmount}
                  fractionDigits={digits}
                  placeholder={maskPlaceholder(digits)}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                  aria-label="Contribution amount"
                  {...invalidProps}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Contribution amount</p>
            </div>

            {linked && (
              <div className="border-b border-border py-3">
                <div className="flex items-center gap-3">
                  <Wallet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Select value={fromAccountId} onValueChange={setFromAccountId}>
                    <SelectTrigger
                      aria-label="Source account"
                      className="h-auto w-full min-w-0 border-0 bg-transparent px-2 py-0 text-sm shadow-none ring-0 focus:ring-0"
                    >
                      <SelectValue placeholder="Select source account" />
                    </SelectTrigger>
                    <SelectContent>
                      {sourceAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="pl-8">
                  <AccountPickerHint
                    loading={accountsResult.isPending}
                    error={accountsResult.isError}
                    empty={sourceAccounts.length === 0}
                    otherCurrency={otherCurrency}
                    currency={currency}
                    noun="other account"
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 border-b border-border py-3">
              <Calendar className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground outline-none [color-scheme:inherit]"
                aria-label="Contribution date"
              />
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                maxLength={1000}
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                aria-label="Note"
              />
            </div>

            <FormError id={ERROR_ID} message={error} />
          </div>

          <div className="mt-2 flex flex-col-reverse gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3 sm:px-5">
            <Button type="button" variant="outline" size="default" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="default" className="w-full sm:w-auto" disabled={isPending || !goal}>
              {isPending ? "Saving..." : "Add contribution"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
