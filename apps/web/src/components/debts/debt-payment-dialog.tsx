import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Debt } from "@/lib/api/types";
import { Calendar, FileText, Percent, Wallet } from "lucide-react";

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
import { splitPayment } from "@/lib/debts";
import { formatMinor, fractionDigits, maskPlaceholder } from "@/lib/money";

interface DebtPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  debt: Debt | null;
}

const ERROR_ID = "debt-payment-error";

export function DebtPaymentDialog({ open, onOpenChange, debt }: DebtPaymentDialogProps) {
  const [amount, setAmount] = useState("");
  const [principalAmount, setPrincipalAmount] = useState("");
  const [interestAmount, setInterestAmount] = useState("");
  const [date, setDate] = useState(localToday);
  const [note, setNote] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [error, setError] = useState("");

  const currency = debt?.currentBalance.currency ?? "USD";
  const digits = fractionDigits(currency);

  // The payment leaves an account in the debt's (base) currency, never the liability it pays down.
  const accountsResult = useQuery({ ...accountsQuery(), enabled: open });
  const { usable, otherCurrency } = accountsForBaseCurrency(accountsResult.data?.items ?? [], currency);
  const sourceAccounts = usable.filter((a) => a.id !== debt?.linkedAccountId);

  const debtId = debt?.id;
  useEffect(() => {
    if (!open) return;
    setAmount("");
    setPrincipalAmount("");
    setInterestAmount("");
    setDate(localToday());
    setNote("");
    setFromAccountId("");
    setError("");
  }, [open, debtId]);

  const { mutateAsync: recordPayment, isPending } = useApiMutation("debtPayments", "record");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!debt || isPending) return;
    setError("");

    const amountMinor = parseCurrencyInput(amount);
    if (Number.isNaN(amountMinor) || amountMinor <= 0) {
      setError("Please enter a valid payment amount");
      return;
    }
    const principal = principalAmount.trim() ? parseCurrencyInput(principalAmount) : null;
    const interest = interestAmount.trim() ? parseCurrencyInput(interestAmount) : null;
    if (Number.isNaN(principal) || Number.isNaN(interest)) {
      setError("Please enter valid principal and interest amounts");
      return;
    }
    const split = splitPayment(amountMinor, principal, interest);
    if ("error" in split) {
      setError(split.error);
      return;
    }
    if (!fromAccountId) {
      setError("Please select a source account");
      return;
    }

    try {
      await recordPayment({
        debtId: debt.id,
        amount: { amountMinor, currency },
        principalAmount: { amountMinor: split.principal, currency },
        interestAmount: { amountMinor: split.interest, currency },
        date: date || localToday(),
        note: note.trim() || undefined,
        fromAccountId,
      });
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't record the payment. Try again."));
    }
  }

  const symbol = getCurrencySymbol(currency);
  const invalidProps = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? ERROR_ID : undefined,
  } as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">Record payment</DialogTitle>
          {debt ? (
            <DialogDescription className="text-sm text-muted-foreground">
              {debt.name} - {formatMinor(debt.currentBalance.amountMinor, currency)} remaining
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">Record a payment toward the debt.</DialogDescription>
          )}
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
            <div className="mb-5">
              <div className="flex items-baseline gap-1 border-b-2 border-primary pb-2">
                <span className="text-2xl font-semibold text-primary">{symbol}</span>
                <CurrencyInput
                  value={amount}
                  onValueChange={setAmount}
                  fractionDigits={digits}
                  placeholder={maskPlaceholder(digits)}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                  aria-label="Payment amount"
                  {...invalidProps}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Payment amount</p>
            </div>

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
                    {sourceAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
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
                  noun="account to pay from"
                />
              </div>
            </div>

            <div className="grid gap-0 sm:grid-cols-2">
              <div className="flex items-center gap-3 border-b border-border py-3 sm:border-r sm:pr-3">
                <span className="w-5 shrink-0 text-center text-sm text-muted-foreground">{symbol}</span>
                <CurrencyInput
                  value={principalAmount}
                  onValueChange={setPrincipalAmount}
                  fractionDigits={digits}
                  placeholder="Principal"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Principal amount"
                />
              </div>

              <div className="flex items-center gap-3 border-b border-border py-3 sm:pl-3">
                <Percent className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <CurrencyInput
                  value={interestAmount}
                  onValueChange={setInterestAmount}
                  fractionDigits={digits}
                  placeholder="Interest"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Interest amount"
                />
              </div>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Optional. A blank part is the rest of the payment; only the principal lowers the balance.
            </p>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <Calendar className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground outline-none [color-scheme:inherit]"
                aria-label="Payment date"
              />
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={note}
                onChange={(event) => setNote(event.target.value)}
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
            <Button type="submit" variant="accent" size="default" className="w-full sm:w-auto" disabled={isPending || !debt}>
              {isPending ? "Saving..." : "Record payment"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
