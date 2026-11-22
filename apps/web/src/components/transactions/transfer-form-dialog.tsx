import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Account } from "@mpf/finance-contract";
import { Calculator, CalendarDays, FileText, Landmark, StickyNote, ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CurrencyInput, parseCurrencyInput } from "@/components/ui/currency-input";
import { ErrorState, FormError } from "@/components/error-state";
import { useAuthProfile } from "@/hooks/use-auth-profile";
import { accountsQuery } from "@/lib/api/queries";
import { transferQuery } from "@/lib/api/ledger";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";
import { fractionDigits, maskPlaceholder } from "@/lib/money";
import { cn } from "@/lib/utils";
import { accountTheme, getDatePreset, localISODate, selectableAccounts } from "./form-helpers";

const ERROR_ID = "transfer-form-error";

interface TransferFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Either leg's id to edit that transfer, or null for create mode. */
  transferId: string | null;
}

export function TransferFormDialog({ open, onOpenChange, transferId }: TransferFormDialogProps) {
  const isEdit = transferId !== null;
  const baseCurrency = useAuthProfile().baseCurrency ?? "USD";

  // Form state
  const [amount, setAmount] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [date, setDate] = useState(localISODate());
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);
  /** The transfer the fields were filled from: a background refetch must not overwrite edits. */
  const [filledFrom, setFilledFrom] = useState<string | null>(null);

  const datePreset = getDatePreset(date);

  const accountsResult = useQuery({ ...accountsQuery({ includeArchived: true }), enabled: open });
  const transferResult = useQuery({ ...transferQuery(transferId ?? ""), enabled: open && isEdit });
  const transfer = transferResult.data?.transfer;

  // Reset on open/close and when switching to create mode.
  useEffect(() => {
    if (!open || !isEdit) {
      setAmount("");
      setFromAccountId("");
      setToAccountId("");
      setDate(localISODate());
      setDescription("");
      setNote("");
      setFilledFrom(null);
    }
    setShowDatePicker(false);
    setError("");
  }, [open, isEdit, transferId]);

  // Fill the fields once the transfer being edited has loaded.
  useEffect(() => {
    if (!open || !transfer || filledFrom === transferId) return;
    setAmount(String(transfer.amount.amountMinor));
    setFromAccountId(transfer.fromAccountId);
    setToAccountId(transfer.toAccountId);
    setDate(transfer.date);
    setDescription(transfer.description ?? "");
    setNote(transfer.note ?? "");
    setFilledFrom(transferId);
  }, [open, transfer, transferId, filledFrom]);

  const { mutateAsync: createTransfer, isPending: isCreating } = useApiMutation("transfers", "create");
  const { mutateAsync: updateTransfer, isPending: isUpdating } = useApiMutation("transfers", "update");
  const isPending = isCreating || isUpdating;

  const accounts = selectableAccounts(accountsResult.data?.items, [transfer?.fromAccountId, transfer?.toAccountId]);
  const fromAccount = accounts.find((a) => a.id === fromAccountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);
  // The amount is in the source account's currency; both accounts must share it.
  const currency = fromAccount?.balance.currency ?? baseCurrency;
  const digits = fractionDigits(currency);
  const loadingTransfer = isEdit && filledFrom !== transferId;

  function changeFrom(next: string) {
    const nextCurrency = accounts.find((a) => a.id === next)?.balance.currency ?? baseCurrency;
    if (fractionDigits(nextCurrency) !== digits) setAmount("");
    setFromAccountId(next);
  }

  async function handleSubmit(andCreateNew = false) {
    if (isPending || loadingTransfer) return;
    setError("");

    const amountMinor = parseCurrencyInput(amount);
    if (!amount || Number.isNaN(amountMinor) || amountMinor <= 0) {
      setError("Please enter a valid amount greater than 0");
      return;
    }
    if (!fromAccount) {
      setError("Please select a source account");
      return;
    }
    if (!toAccount) {
      setError("Please select a destination account");
      return;
    }
    if (fromAccount.id === toAccount.id) {
      setError("Source and destination accounts must be different");
      return;
    }
    if (fromAccount.balance.currency !== toAccount.balance.currency) {
      setError(
        `Both accounts must use the same currency (${fromAccount.balance.currency} and ${toAccount.balance.currency}).`,
      );
      return;
    }
    if (!date) {
      setError("Please select a date");
      return;
    }

    const fields = {
      amount: { amountMinor, currency },
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      date,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };

    try {
      if (transferId) {
        await updateTransfer({ id: transferId, ...fields });
        onOpenChange(false);
        return;
      }
      await createTransfer(fields);
      if (andCreateNew) {
        setAmount("");
        setFromAccountId("");
        setToAccountId("");
        setDate(localISODate());
        setDescription("");
        setNote("");
        setShowDatePicker(false);
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(apiErrorMessage(err, isEdit ? "Couldn't save the transfer. Try again." : "Couldn't add the transfer. Try again."));
    }
  }

  const errorProps = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? ERROR_ID : undefined,
  } as const;
  const presetClass = (active: boolean) =>
    cn(
      "rounded-full px-3 py-1 text-sm font-medium transition-colors",
      active ? "bg-blue-500 text-white" : "bg-muted text-muted-foreground hover:text-foreground",
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        {/* Header */}
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">{isEdit ? "Edit transfer" : "New transfer"}</DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? "Change the amount, accounts or date of this transfer." : "Move money between two of your accounts."}
          </DialogDescription>
        </DialogHeader>

        {isEdit && transferResult.isError && !transfer ? (
          <div className="px-4 py-4 sm:px-5">
            <ErrorState
              error={transferResult.error}
              fallback="Couldn't load the transfer. Try again."
              onRetry={() => void transferResult.refetch()}
            />
          </div>
        ) : loadingTransfer ? (
          <div className="space-y-4 px-4 py-5 sm:px-5" aria-busy="true" aria-label="Loading transfer">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <>
            <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
              {/* ── Amount input (prominent, top) ── */}
              <div className="mb-5">
                <div className="flex items-center gap-2 border-b-2 border-blue-500 dark:border-blue-400 pb-2">
                  <Calculator className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
                  <CurrencyInput
                    value={amount}
                    onValueChange={setAmount}
                    fractionDigits={digits}
                    placeholder={maskPlaceholder(digits)}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                    aria-label="Amount"
                    {...errorProps}
                  />
                  <span className="shrink-0 text-sm font-medium text-muted-foreground">{currency}</span>
                </div>
              </div>

              {/* ── From account ── */}
              <AccountRow
                label="From"
                placeholder="Source account"
                value={fromAccountId}
                onChange={changeFrom}
                options={accounts.filter((a) => a.id !== toAccountId)}
                selected={fromAccount}
                errorProps={errorProps}
              />

              {/* ── Arrow indicator ── */}
              <div className="flex justify-center py-1" aria-hidden="true">
                <div className="flex items-center justify-center size-6 rounded-full bg-blue-500/10">
                  <ArrowDown className="size-3.5 text-blue-500" />
                </div>
              </div>

              {/* ── To account ── */}
              <AccountRow
                label="To"
                placeholder="Destination account"
                value={toAccountId}
                onChange={setToAccountId}
                options={accounts.filter((a) => a.id !== fromAccountId)}
                selected={toAccount}
                errorProps={errorProps}
              />

              {/* ── Date field (quick picks) ── */}
              <div className="flex items-center gap-3 border-b border-border py-3">
                <CalendarDays className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
                <div className="flex flex-1 flex-wrap items-center gap-2" role="group" aria-label="Date">
                  <button
                    type="button"
                    aria-pressed={datePreset === "today"}
                    onClick={() => {
                      setDate(localISODate(0));
                      setShowDatePicker(false);
                    }}
                    className={presetClass(datePreset === "today")}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    aria-pressed={datePreset === "yesterday"}
                    onClick={() => {
                      setDate(localISODate(1));
                      setShowDatePicker(false);
                    }}
                    className={presetClass(datePreset === "yesterday")}
                  >
                    Yesterday
                  </button>
                  <button
                    type="button"
                    aria-pressed={datePreset === "other"}
                    aria-expanded={showDatePicker}
                    onClick={() => setShowDatePicker(!showDatePicker)}
                    className={presetClass(datePreset === "other")}
                  >
                    Other...
                  </button>
                </div>
              </div>

              {/* ── Date picker (hidden until "Other..." is clicked) ── */}
              {showDatePicker && (
                <div className="border-b border-border py-3 pl-8">
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="bg-transparent text-sm text-foreground outline-none"
                    aria-label="Pick a date"
                  />
                </div>
              )}

              {/* ── Description ── */}
              <div className="flex items-center gap-3 border-b border-border py-3">
                <FileText className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description"
                  maxLength={500}
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Description"
                />
              </div>

              {/* ── Note ── */}
              <div className="flex items-center gap-3 border-b border-border py-3">
                <StickyNote className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note"
                  maxLength={1000}
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Note"
                />
              </div>

              {/* ── Error ── */}
              <FormError id={ERROR_ID} message={error} />
            </div>

            {/* ── Footer with actions ── */}
            <div className="mt-2 flex flex-col-reverse gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3 sm:px-5">
              {!isEdit && (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  className="w-full sm:w-auto"
                  disabled={isPending}
                  onClick={() => void handleSubmit(true)}
                >
                  {isPending ? "Saving..." : "Save & new"}
                </Button>
              )}
              <Button
                type="button"
                variant="accent"
                size="default"
                className="w-full sm:w-auto"
                disabled={isPending}
                onClick={() => void handleSubmit(false)}
              >
                {isPending ? "Saving..." : isEdit ? "Save changes" : "Save"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Account picker row                                                        */
/* -------------------------------------------------------------------------- */

interface AccountRowProps {
  label: "From" | "To";
  placeholder: string;
  value: string;
  onChange: (id: string) => void;
  options: Account[];
  selected: Account | undefined;
  errorProps: { "aria-invalid"?: true; "aria-describedby"?: string };
}

function AccountRow({ label, placeholder, value, onChange, options, selected, errorProps }: AccountRowProps) {
  const theme = selected ? accountTheme(selected) : null;
  return (
    <div className="flex items-center gap-3 border-b border-border py-3">
      <Landmark className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide w-10 shrink-0" aria-hidden="true">
        {label}
      </span>
      <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? "" : v)}>
        <SelectTrigger
          aria-label={`${label} account`}
          {...errorProps}
          className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5"
        >
          <SelectValue>
            {selected ? (
              <span className="flex items-center gap-1.5">
                {theme && (
                  <span
                    aria-hidden="true"
                    className="inline-block size-4 rounded-full shrink-0"
                    style={{ background: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}
                  />
                )}
                {selected.name}
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__" disabled>
            Select account
          </SelectItem>
          {options.map((a) => {
            const t = accountTheme(a);
            return (
              <SelectItem key={a.id} value={a.id}>
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block size-3.5 rounded-full shrink-0"
                    style={{ background: `linear-gradient(135deg, ${t.from}, ${t.to})` }}
                  />
                  {a.name}
                  <span className="text-xs text-muted-foreground">{a.balance.currency}</span>
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
