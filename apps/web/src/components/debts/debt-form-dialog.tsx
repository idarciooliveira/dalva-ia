import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Debt, DebtType } from "@/lib/api/types";
import { Calendar, CreditCard, Landmark, Percent, Wallet } from "lucide-react";

import { AccountPickerHint } from "@/components/account-picker-hint";
import { FormError } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CurrencyInput, parseCurrencyInput } from "@/components/ui/currency-input";
import { useAuthProfile } from "@/hooks/use-auth-profile";
import { accountsForBaseCurrency } from "@/lib/accounts";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { accountsQuery } from "@/lib/api/queries";
import { getCurrencySymbol } from "@/lib/currencies";
import {
  clearedDebtFields,
  DEBT_TYPES,
  debtChanges,
  type DebtFormFields,
  exceedsOriginal,
  parseInterestRate,
} from "@/lib/debts";
import { fractionDigits, maskPlaceholder } from "@/lib/money";

interface DebtFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  debt: Debt | null;
}

/** Liability accounts a debt can pay down (as under Convex), in the base currency. */
const LIABILITY_TYPES = ["credit_card", "loan"] as const;
const NO_ACCOUNT = "none";
const ERROR_ID = "debt-form-error";

export function DebtFormDialog({ open, onOpenChange, debt }: DebtFormDialogProps) {
  const isEdit = debt !== null;
  // Debts are in the base currency; an edited debt keeps the currency the API labels it with.
  const baseCurrency = useAuthProfile().baseCurrency ?? "USD";
  const currency = debt?.originalAmount.currency ?? baseCurrency;
  const digits = fractionDigits(currency);

  const [name, setName] = useState("");
  const [debtType, setDebtType] = useState<DebtType>("credit_card");
  const [originalAmount, setOriginalAmount] = useState("");
  const [currentBalance, setCurrentBalance] = useState("");
  const [lender, setLender] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [minimumPayment, setMinimumPayment] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [linkedAccountId, setLinkedAccountId] = useState(NO_ACCOUNT);
  const [error, setError] = useState("");
  // The debt as the dialog opened with it: edits are diffed against this, not the live row (see handleSubmit).
  const [opened, setOpened] = useState<Debt | null>(null);

  const accountsResult = useQuery({ ...accountsQuery(), enabled: open });
  const { usable: liabilityAccounts, otherCurrency } = accountsForBaseCurrency(
    accountsResult.data?.items ?? [],
    currency,
    LIABILITY_TYPES,
  );
  // An edited debt may point at an account not listed (archived, or legacy in another currency): keep it selectable.
  const unlistedAccountId = liabilityAccounts.some((a) => a.id === debt?.linkedAccountId) ? undefined : debt?.linkedAccountId;

  const debtId = debt?.id;
  useEffect(() => {
    if (!open) return;
    setName(debt?.name ?? "");
    setDebtType(debt?.debtType ?? "credit_card");
    setOriginalAmount(debt ? String(debt.originalAmount.amountMinor) : "");
    setCurrentBalance(debt ? String(debt.currentBalance.amountMinor) : "");
    setLender(debt?.lender ?? "");
    setInterestRate(debt?.interestRate !== undefined ? String(debt.interestRate) : "");
    setMinimumPayment(debt?.minimumPayment ? String(debt.minimumPayment.amountMinor) : "");
    setDueDate(debt?.dueDate ?? "");
    setLinkedAccountId(debt?.linkedAccountId ?? NO_ACCOUNT);
    setError("");
    setOpened(debt);
  }, [open, debtId]);

  const { mutateAsync: createDebt, isPending: isCreating } = useApiMutation("debts", "create");
  const { mutateAsync: updateDebt, isPending: isUpdating } = useApiMutation("debts", "update");
  const isPending = isCreating || isUpdating;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isPending) return;
    setError("");

    if (!name.trim()) {
      setError("Debt name is required");
      return;
    }
    const original = parseCurrencyInput(originalAmount);
    const current = parseCurrencyInput(currentBalance);
    const minimum = minimumPayment.trim() ? parseCurrencyInput(minimumPayment) : null;
    const rate = parseInterestRate(interestRate);
    if (Number.isNaN(original) || original <= 0) {
      setError("Please enter a valid original amount");
      return;
    }
    if (Number.isNaN(current) || current < 0) {
      setError("Please enter a valid current balance");
      return;
    }
    if (minimum !== null && (Number.isNaN(minimum) || minimum < 0)) {
      setError("Please enter a valid minimum payment");
      return;
    }
    if (rate !== null && Number.isNaN(rate)) {
      setError("Please enter a valid interest rate");
      return;
    }

    const money = (amountMinor: number) => ({ amountMinor, currency });
    const fields: DebtFormFields = {
      name: name.trim(),
      debtType,
      originalAmount: money(original),
      currentBalance: money(current),
      lender: lender.trim() || undefined,
      interestRate: rate ?? undefined,
      minimumPayment: minimum === null ? undefined : money(minimum),
      dueDate: dueDate || undefined,
      linkedAccountId: linkedAccountId === NO_ACCOUNT ? undefined : linkedAccountId,
    };
    // Edits are compared with the debt as the dialog opened with it, not the live (refetched) row.
    const from = opened ?? debt;
    if (exceedsOriginal(from, fields)) {
      setError("Current balance cannot exceed the original amount");
      return;
    }
    const cleared = from ? clearedDebtFields(from, fields) : [];
    if (cleared.length > 0) {
      setError(`The ${cleared.join(", ")} can be changed but not removed`);
      return;
    }

    try {
      if (isEdit) {
        const changes = debtChanges(from ?? debt, fields);
        if (changes) await updateDebt({ id: debt.id, ...changes });
      } else {
        await createDebt(fields);
      }
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, isEdit ? "Couldn't save the debt. Try again." : "Couldn't create the debt. Try again."));
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
          <DialogTitle className="text-lg font-semibold">{isEdit ? "Edit debt" : "New debt"}</DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? "Change the debt's balances and details." : "Track what you owe and how it is paid down."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
            <div className="mb-5 grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-1 border-b-2 border-primary pb-2">
                  <span className="text-2xl font-semibold text-primary">{symbol}</span>
                  <CurrencyInput
                    value={currentBalance}
                    onValueChange={setCurrentBalance}
                    fractionDigits={digits}
                    placeholder={maskPlaceholder(digits)}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-2xl font-semibold tabular-nums text-foreground outline-none placeholder:text-muted-foreground/50"
                    aria-label="Current balance"
                    {...invalidProps}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Current balance</p>
              </div>

              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-1 border-b-2 border-border pb-2">
                  <span className="text-2xl font-semibold text-muted-foreground">{symbol}</span>
                  <CurrencyInput
                    value={originalAmount}
                    onValueChange={setOriginalAmount}
                    fractionDigits={digits}
                    placeholder={maskPlaceholder(digits)}
                    className="min-w-0 flex-1 bg-transparent text-2xl font-semibold tabular-nums text-foreground outline-none placeholder:text-muted-foreground/50"
                    aria-label="Original amount"
                    {...invalidProps}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Original amount</p>
              </div>
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <CreditCard className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Debt name"
                maxLength={100}
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                aria-label="Debt name"
                {...invalidProps}
              />
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <Wallet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Select value={debtType} onValueChange={(v) => setDebtType(v as DebtType)}>
                <SelectTrigger
                  aria-label="Debt type"
                  className="h-auto w-full min-w-0 border-0 bg-transparent px-2 py-0 text-sm shadow-none ring-0 focus:ring-0"
                >
                  <SelectValue placeholder="Debt type" />
                </SelectTrigger>
                <SelectContent>
                  {DEBT_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <Landmark className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={lender}
                onChange={(event) => setLender(event.target.value)}
                placeholder="Lender (optional)"
                maxLength={100}
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                aria-label="Lender"
              />
            </div>

            <div className="grid gap-0 sm:grid-cols-2">
              <div className="flex items-center gap-3 border-b border-border py-3 sm:border-r sm:pr-3">
                <Percent className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                  type="text"
                  inputMode="decimal"
                  value={interestRate}
                  onChange={(event) => setInterestRate(event.target.value.replace(/[^0-9.,]/g, ""))}
                  placeholder="APR %"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Interest rate"
                />
              </div>

              <div className="flex items-center gap-3 border-b border-border py-3 sm:pl-3">
                <span className="w-5 shrink-0 text-center text-sm text-muted-foreground">{symbol}</span>
                <CurrencyInput
                  value={minimumPayment}
                  onValueChange={setMinimumPayment}
                  fractionDigits={digits}
                  placeholder="Minimum payment"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Minimum payment"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 border-b border-border py-3">
              <Calendar className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground outline-none [color-scheme:inherit]"
                aria-label="Due date"
              />
            </div>

            <div className="border-b border-border py-3">
              <div className="flex items-center gap-3">
                <Wallet className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Select value={linkedAccountId} onValueChange={setLinkedAccountId}>
                  <SelectTrigger
                    aria-label="Linked liability account"
                    className="h-auto w-full min-w-0 border-0 bg-transparent px-2 py-0 text-sm shadow-none ring-0 focus:ring-0"
                  >
                    <SelectValue placeholder="Link liability account" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Once linked, a debt can switch accounts but not unlink (the API can't clear the field). */}
                    {!debt?.linkedAccountId && <SelectItem value={NO_ACCOUNT}>No linked liability account</SelectItem>}
                    {unlistedAccountId && <SelectItem value={unlistedAccountId}>Current account</SelectItem>}
                    {liabilityAccounts.map((account) => (
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
                  empty={false}
                  otherCurrency={otherCurrency}
                  currency={currency}
                  noun="credit card or loan account"
                />
              </div>
            </div>

            <FormError id={ERROR_ID} message={error} />
          </div>

          <div className="mt-2 flex flex-col-reverse gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3 sm:px-5">
            <Button type="button" variant="outline" size="default" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="default" className="w-full sm:w-auto" disabled={isPending || !name.trim()}>
              {isPending ? "Saving..." : isEdit ? "Save changes" : "Create debt"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
