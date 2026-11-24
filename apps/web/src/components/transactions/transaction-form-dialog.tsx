import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Transaction } from "@mpf/finance-contract";
import {
  Calculator,
  CheckCircle2,
  CalendarDays,
  FileText,
  Tag,
  Landmark,
  StickyNote,
  User,
  ChevronDown,
} from "lucide-react";

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
import { CurrencyInput, parseCurrencyInput } from "@/components/ui/currency-input";
import { Switch } from "@/components/ui/switch";
import { FormError } from "@/components/error-state";
import { useAuthProfile } from "@/hooks/use-auth-profile";
import { accountsQuery, categoriesQuery, subcategoriesQuery } from "@/lib/api/queries";
import { useApiMutation } from "@/lib/api/mutations";
import { apiErrorMessage } from "@/lib/api/errors";
import { fractionDigits, maskPlaceholder } from "@/lib/money";
import { cn } from "@/lib/utils";
import { accountTheme, getDatePreset, localISODate, selectableAccounts, transactionChanges } from "./form-helpers";

type TxType = "income" | "expense";

const ERROR_ID = "transaction-form-error";

interface TransactionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An income or expense row to edit, or null for create mode. */
  transaction: Transaction | null;
  /** Pre-select the transaction type (used by FAB). */
  defaultType?: TxType;
}

export function TransactionFormDialog({
  open,
  onOpenChange,
  transaction,
  defaultType,
}: TransactionFormDialogProps) {
  const isEdit = transaction !== null;
  const baseCurrency = useAuthProfile().baseCurrency ?? "USD";

  // Form state
  const [type, setType] = useState<TxType>(defaultType ?? "expense");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [date, setDate] = useState(localISODate());
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [payee, setPayee] = useState("");
  const [isPaid, setIsPaid] = useState(true);
  const [error, setError] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const datePreset = getDatePreset(date);
  const amountRef = useRef<HTMLInputElement>(null);

  // Archived accounts and categories stay listed only when the row already uses them.
  const accountsResult = useQuery({ ...accountsQuery({ includeArchived: true }), enabled: open });
  const categoriesResult = useQuery({ ...categoriesQuery({ includeArchived: true }), enabled: open });
  const subcategoriesResult = useQuery({
    ...subcategoriesQuery({ categoryId, includeArchived: true }),
    enabled: open && categoryId !== "",
  });

  const accounts = selectableAccounts(accountsResult.data?.items, [transaction?.accountId]);
  const filteredCategories = (categoriesResult.data?.items ?? []).filter(
    (c) => c.type === type && (!c.archived || c.id === transaction?.categoryId),
  );
  const subcategories = (subcategoriesResult.data?.items ?? []).filter(
    (sc) => !sc.archived || sc.id === transaction?.subcategoryId,
  );

  // Fill the form on open. Closing keeps the fields, so the dialog doesn't flash empty while it animates out.
  useEffect(() => {
    if (!open) return;
    if (transaction) {
      setType(transaction.type === "income" ? "income" : "expense");
      setAmount(String(transaction.amount.amountMinor));
      setAccountId(transaction.accountId);
      setCategoryId(transaction.categoryId ?? "");
      setSubcategoryId(transaction.subcategoryId ?? "");
      setDate(transaction.date);
      setDescription(transaction.description ?? "");
      setNote(transaction.note ?? "");
      setPayee(transaction.payee ?? "");
      setShowMore(!!(transaction.note || transaction.payee));
    } else {
      setType(defaultType ?? "expense");
      resetFields();
    }
    setIsPaid(true);
    setShowDatePicker(false);
    setError("");
  }, [transaction, open, defaultType]);

  function resetFields() {
    setAmount("");
    setAccountId("");
    setCategoryId("");
    setSubcategoryId("");
    setDate(localISODate());
    setDescription("");
    setNote("");
    setPayee("");
    setShowMore(false);
  }

  const { mutateAsync: createTransaction, isPending: isCreating } = useApiMutation("transactions", "create");
  const { mutateAsync: updateTransaction, isPending: isUpdating } = useApiMutation("transactions", "update");
  const isPending = isCreating || isUpdating;
  // The account select (and the amount's precision) need the accounts.
  const accountsLoading = accountsResult.isPending && accountsResult.fetchStatus !== "idle";

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const selectedCategory = filteredCategories.find((c) => c.id === categoryId);
  // Amounts are typed in the account's minor units: the row's own currency while
  // accounts load, the base currency until one is picked.
  const currency =
    selectedAccount?.balance.currency ??
    (transaction && accountId === transaction.accountId ? transaction.amount.currency : baseCurrency);
  const digits = fractionDigits(currency);

  function changeAccount(next: string) {
    const nextCurrency = accounts.find((a) => a.id === next)?.balance.currency ?? baseCurrency;
    // The typed digits mean another amount at another precision (USD 15,00 -> JPY 1.500).
    if (fractionDigits(nextCurrency) !== digits) setAmount("");
    setAccountId(next);
  }

  function changeType(next: TxType) {
    if (next === type) return;
    setType(next);
    // Categories are per type: the selected one no longer applies.
    setCategoryId("");
    setSubcategoryId("");
  }

  async function handleSubmit(andCreateNew = false) {
    if (isPending) return;
    setError("");

    const amountMinor = parseCurrencyInput(amount);
    if (!amount || Number.isNaN(amountMinor) || amountMinor <= 0) {
      setError("Please enter a valid amount greater than 0");
      return;
    }
    if (!selectedAccount) {
      setError("Please select an account");
      return;
    }
    if (!date) {
      setError("Please select a date");
      return;
    }
    // The API changes only the fields it is sent, so a saved category can be replaced but not removed.
    if (transaction?.categoryId && !categoryId) {
      setError("Choose a category. A saved transaction's category can be changed but not removed.");
      return;
    }

    const amountValue = { amountMinor, currency };

    try {
      if (transaction) {
        const changes = transactionChanges(transaction, {
          type,
          amount: amountValue,
          accountId: selectedAccount.id,
          date,
          categoryId,
          subcategoryId,
          description,
          note,
          payee,
        });
        // Nothing changed: no request (the API refuses an empty update).
        if (Object.keys(changes).length > 0) await updateTransaction({ id: transaction.id, ...changes });
        onOpenChange(false);
        return;
      }
      await createTransaction({
        type,
        amount: amountValue,
        accountId: selectedAccount.id,
        date,
        ...(categoryId ? { categoryId } : {}),
        ...(subcategoryId ? { subcategoryId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(payee.trim() ? { payee: payee.trim() } : {}),
      });
      if (andCreateNew) {
        resetFields();
        setShowDatePicker(false);
        amountRef.current?.focus();
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(
        apiErrorMessage(err, isEdit ? "Couldn't save the transaction. Try again." : "Couldn't add the transaction. Try again."),
      );
    }
  }

  const theme = selectedAccount ? accountTheme(selectedAccount) : null;
  const accentColor = type === "expense" ? "border-destructive" : "border-emerald-500 dark:border-emerald-400";
  const typeLabel = `${isEdit ? "Edit" : "New"} ${type}`;
  const errorProps = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? ERROR_ID : undefined,
  } as const;
  const presetClass = (active: boolean) =>
    cn(
      "rounded-full px-3 py-1 text-sm font-medium transition-colors",
      active
        ? type === "expense"
          ? "bg-destructive text-white"
          : "bg-emerald-500 text-white"
        : "bg-muted text-muted-foreground hover:text-foreground",
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A save in flight finishes in this dialog: its result must not land in the next one opened.
        if (!next && isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        {/* Header */}
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">
            {typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? "Change the amount, date, category or account of this record." : "Record income or an expense on one of your accounts."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
          {/* ── Type toggle (compact pill) ── */}
          <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Transaction type">
            <button
              type="button"
              onClick={() => changeType("income")}
              aria-pressed={type === "income"}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                type === "income"
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              Income
            </button>
            <button
              type="button"
              onClick={() => changeType("expense")}
              aria-pressed={type === "expense"}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                type === "expense"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              Expense
            </button>
          </div>

          {/* ── Amount input (prominent, top) ── */}
          <div className="mb-5">
            <div className={cn("flex items-center gap-2 border-b-2 pb-2", accentColor)}>
              <Calculator className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
              <CurrencyInput
                ref={amountRef}
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

          {/* ── Paid toggle ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <CheckCircle2 className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="flex-1 text-sm text-foreground">Was paid</span>
            <Switch checked={isPaid} onCheckedChange={setIsPaid} aria-label="Was paid" />
          </div>

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

          {/* ── Category ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <Tag className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
            <Select
              value={categoryId || "__none__"}
              onValueChange={(v) => {
                setCategoryId(v === "__none__" ? "" : v);
                // A subcategory belongs to its category.
                setSubcategoryId("");
              }}
            >
              <SelectTrigger
                aria-label="Category"
                className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5"
              >
                <SelectValue>
                  {selectedCategory ? (
                    <span className="flex items-center gap-1.5">
                      {selectedCategory.icon && (
                        <span
                          aria-hidden="true"
                          className="inline-flex items-center justify-center size-4 rounded text-[10px]"
                          style={{
                            backgroundColor: selectedCategory.color ? `${selectedCategory.color}20` : undefined,
                            color: selectedCategory.color ?? undefined,
                          }}
                        >
                          {selectedCategory.icon.charAt(0).toUpperCase()}
                        </span>
                      )}
                      {selectedCategory.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Category</span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {filteredCategories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Subcategory (only if category is selected and has subcategories) ── */}
          {categoryId && subcategories.length > 0 && (
            <div className="flex items-center gap-3 border-b border-border py-3 pl-8">
              <Select
                value={subcategoryId || "__none__"}
                onValueChange={(v) => setSubcategoryId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger
                  aria-label="Subcategory"
                  className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5"
                >
                  <SelectValue>
                    {subcategories.find((sc) => sc.id === subcategoryId)?.name ?? "Subcategory"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {subcategories.map((sc) => (
                    <SelectItem key={sc.id} value={sc.id}>
                      {sc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* ── Account ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <Landmark className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
            <Select value={accountId || "__none__"} onValueChange={(v) => changeAccount(v === "__none__" ? "" : v)}>
              <SelectTrigger
                aria-label="Account"
                {...errorProps}
                className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5"
              >
                <SelectValue>
                  {selectedAccount ? (
                    <span className="flex items-center gap-1.5">
                      {theme && (
                        <span
                          aria-hidden="true"
                          className="inline-block size-4 rounded-full shrink-0"
                          style={{ background: `linear-gradient(135deg, ${theme.from}, ${theme.to})` }}
                        />
                      )}
                      {selectedAccount.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Account</span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" disabled>
                  Select account
                </SelectItem>
                {accounts.map((a) => {
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
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* ── More details toggle ── */}
          {!showMore && (
            <button
              type="button"
              onClick={() => setShowMore(true)}
              aria-expanded={false}
              className="flex items-center gap-1 py-3 text-sm font-semibold text-foreground hover:text-foreground/80 transition-colors w-full justify-end"
            >
              More details
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
          )}

          {/* ── Extended fields (payee, note) ── */}
          {showMore && (
            <>
              <div className="flex items-center gap-3 border-b border-border py-3">
                <User className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
                <input
                  type="text"
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  placeholder="Payee"
                  maxLength={200}
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Payee"
                />
              </div>

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
            </>
          )}

          {/* ── Error ── */}
          {accountsResult.isError && !accountsResult.data && (
            <FormError message={apiErrorMessage(accountsResult.error, "Couldn't load your accounts. Close and try again.")} />
          )}
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
              disabled={isPending || accountsLoading}
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
            disabled={isPending || accountsLoading}
            onClick={() => void handleSubmit(false)}
          >
            {isPending ? "Saving..." : isEdit ? "Save changes" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
