import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useConvexMutation, convexQuery } from "@convex-dev/react-query";
import { api } from "@mpf/backend/convex/_generated/api";
import type { Doc, Id } from "@mpf/backend/convex/_generated/dataModel";
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
import { CurrencyInput, parseCurrencyInputToCents } from "@/components/ui/currency-input";
import { Switch } from "@/components/ui/switch";
import { convexErrorMessage, TRANSACTION_MANAGED } from "@/lib/convex-errors";
import { ACCOUNT_THEMES } from "@/lib/accounts";
import { cn } from "@/lib/utils";

type TxType = "income" | "expense";

function isEditableTransactionType(type: Doc<"transactions">["type"]): type is TxType {
  return type === "income" || type === "expense";
}

interface TransactionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a transaction to edit, or null for create mode. */
  transaction: Doc<"transactions"> | null;
  /** Pre-select the transaction type (used by FAB). */
  defaultType?: TxType;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type DatePreset = "today" | "yesterday" | "other";

function getDatePreset(dateStr: string): DatePreset {
  if (dateStr === todayISO()) return "today";
  if (dateStr === yesterdayISO()) return "yesterday";
  return "other";
}

export function TransactionFormDialog({
  open,
  onOpenChange,
  transaction,
  defaultType,
}: TransactionFormDialogProps) {
  const isEdit = transaction !== null;

  // Form state
  const [type, setType] = useState<TxType>(defaultType ?? "expense");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [payee, setPayee] = useState("");
  const [isPaid, setIsPaid] = useState(true);
  const [error, setError] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const datePreset = getDatePreset(date);

  // Fetch accounts & categories
  const { data: accounts } = useQuery(
    convexQuery(api.accounts.listAccounts, {}),
  );
  const { data: categories } = useQuery(
    convexQuery(api.categories.listCategories, {}),
  );

  // Filter categories by selected type
  const filteredCategories = (categories ?? []).filter(
    (c) => c.type === type && !c.archived,
  );

  // Fetch subcategories for selected category
  const { data: subcategories } = useQuery(
    convexQuery(
      api.categories.listSubcategories,
      categoryId
        ? { categoryId: categoryId as Id<"categories"> }
        : "skip",
    ),
  );

  // Reset form when opening/closing or switching between create/edit
  useEffect(() => {
    if (transaction) {
      setType(isEditableTransactionType(transaction.type) ? transaction.type : "expense");
      setAmount(String(transaction.amount));
      setAccountId(transaction.accountId);
      setCategoryId(transaction.categoryId ?? "");
      setSubcategoryId(transaction.subcategoryId ?? "");
      setDate(transaction.date);
      setDescription(transaction.description ?? "");
      setNote(transaction.note ?? "");
      setPayee(transaction.payee ?? "");
      setIsPaid(true);
      setShowMore(
        !!(transaction.note || transaction.payee),
      );
      setShowDatePicker(false);
    } else {
      setType(defaultType ?? "expense");
      setAmount("");
      setAccountId("");
      setCategoryId("");
      setSubcategoryId("");
      setDate(todayISO());
      setDescription("");
      setNote("");
      setPayee("");
      setIsPaid(true);
      setShowMore(false);
      setShowDatePicker(false);
    }
    setError("");
  }, [transaction, open, defaultType]);

  // Clear subcategory when category changes
  useEffect(() => {
    if (!transaction) setSubcategoryId("");
  }, [categoryId, transaction]);

  // Mutations
  const { mutateAsync: createTransaction, isPending: isCreating } = useMutation(
    { mutationFn: useConvexMutation(api.transactions.createTransaction) },
  );
  const { mutateAsync: updateTransaction, isPending: isUpdating } = useMutation(
    { mutationFn: useConvexMutation(api.transactions.updateTransaction) },
  );

  const isPending = isCreating || isUpdating;

  async function handleSubmit(andCreateNew = false) {
    setError("");

    // Validate
    const amountCents = parseCurrencyInputToCents(amount);
    if (!amount || isNaN(amountCents) || amountCents <= 0) {
      setError("Please enter a valid amount greater than 0");
      return;
    }
    if (!accountId) {
      setError("Please select an account");
      return;
    }
    if (!date) {
      setError("Please select a date");
      return;
    }

    try {
      if (isEdit && transaction) {
        await updateTransaction({
          id: transaction._id,
          type,
          amount: amountCents,
          accountId: accountId as Id<"accounts">,
          date,
          ...(categoryId
            ? { categoryId: categoryId as Id<"categories"> }
            : {}),
          ...(subcategoryId
            ? { subcategoryId: subcategoryId as Id<"subcategories"> }
            : {}),
          description: description || undefined,
          note: note || undefined,
          payee: payee || undefined,
        });
        onOpenChange(false);
      } else {
        await createTransaction({
          type,
          amount: amountCents,
          accountId: accountId as Id<"accounts">,
          date,
          ...(categoryId
            ? { categoryId: categoryId as Id<"categories"> }
            : {}),
          ...(subcategoryId
            ? { subcategoryId: subcategoryId as Id<"subcategories"> }
            : {}),
          description: description || undefined,
          note: note || undefined,
          payee: payee || undefined,
        });

        if (andCreateNew) {
          // Reset form for another entry
          setAmount("");
          setAccountId("");
          setCategoryId("");
          setSubcategoryId("");
          setDate(todayISO());
          setDescription("");
          setNote("");
          setPayee("");
          setIsPaid(true);
          setShowMore(false);
          setShowDatePicker(false);
          setError("");
        } else {
          onOpenChange(false);
        }
      }
    } catch (err) {
      setError(
        convexErrorMessage(err, TRANSACTION_MANAGED) ??
          (err instanceof Error ? err.message : "Something went wrong"),
      );
    }
  }

  // Helpers
  const selectedAccount = (accounts ?? []).find((a) => a._id === accountId);
  const selectedCategory = (categories ?? []).find(
    (c) => c._id === categoryId,
  );
  const accountTheme = selectedAccount
    ? ACCOUNT_THEMES.find((t) => t.id === (selectedAccount.theme ?? "default")) ??
      ACCOUNT_THEMES[0]
    : null;

  const accentColor =
    type === "expense"
      ? "border-destructive"
      : "border-emerald-500 dark:border-emerald-400";

  const typeLabel =
    type === "expense"
      ? isEdit
        ? "Edit expense"
        : "New expense"
      : isEdit
        ? "Edit income"
        : "New income";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        {/* Header */}
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">
            {typeLabel}
          </DialogTitle>
        </DialogHeader>

        <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
          {/* ── Type toggle (compact pill) ── */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setType("income")}
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
              onClick={() => setType("expense")}
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
            <div
              className={cn(
                "flex items-center gap-2 border-b-2 pb-2",
                accentColor,
              )}
            >
              <Calculator className="size-5 text-muted-foreground shrink-0" />
              <CurrencyInput
                value={amount}
                onValueChange={setAmount}
                placeholder="0,00"
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                aria-label="Amount"
              />
            </div>
          </div>

          {/* ── Paid toggle ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <CheckCircle2 className="size-5 text-muted-foreground shrink-0" />
            <span className="flex-1 text-sm text-foreground">Was paid</span>
            <Switch
              checked={isPaid}
              onCheckedChange={setIsPaid}
              aria-label="Was paid"
            />
          </div>

          {/* ── Date field (quick picks) ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <CalendarDays className="size-5 text-muted-foreground shrink-0" />
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDate(todayISO());
                  setShowDatePicker(false);
                }}
                className={cn(
                  "rounded-full px-3 py-1 text-sm font-medium transition-colors",
                  datePreset === "today"
                    ? type === "expense"
                      ? "bg-destructive text-white"
                      : "bg-emerald-500 text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => {
                  setDate(yesterdayISO());
                  setShowDatePicker(false);
                }}
                className={cn(
                  "rounded-full px-3 py-1 text-sm font-medium transition-colors",
                  datePreset === "yesterday"
                    ? type === "expense"
                      ? "bg-destructive text-white"
                      : "bg-emerald-500 text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                Yesterday
              </button>
              <button
                type="button"
                onClick={() => setShowDatePicker(!showDatePicker)}
                className={cn(
                  "rounded-full px-3 py-1 text-sm font-medium transition-colors",
                  datePreset === "other"
                    ? type === "expense"
                      ? "bg-destructive text-white"
                      : "bg-emerald-500 text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
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
            <FileText className="size-5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Description"
            />
          </div>

          {/* ── Category ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <Tag className="size-5 text-muted-foreground shrink-0" />
            <Select
              value={categoryId || "__none__"}
              onValueChange={(v) => setCategoryId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5">
                <SelectValue>
                  {selectedCategory ? (
                    <span className="flex items-center gap-1.5">
                      {selectedCategory.icon && (
                        <span
                          className="inline-flex items-center justify-center size-4 rounded text-[10px]"
                          style={{
                            backgroundColor: selectedCategory.color
                              ? `${selectedCategory.color}20`
                              : undefined,
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
                  <SelectItem key={c._id} value={c._id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Subcategory (only if category is selected and has subcategories) ── */}
          {categoryId && (subcategories ?? []).length > 0 && (
             <div className="flex items-center gap-3 border-b border-border py-3 pl-8">
              <Select
                value={subcategoryId || "__none__"}
                onValueChange={(v) =>
                  setSubcategoryId(v === "__none__" ? "" : v)
                }
              >
               <SelectTrigger className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5">
                  <SelectValue>
                    {subcategoryId
                      ? (subcategories ?? []).find(
                          (sc) => sc._id === subcategoryId,
                        )?.name ?? "Subcategory"
                      : "Subcategory"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {(subcategories ?? []).map((sc) => (
                    <SelectItem key={sc._id} value={sc._id}>
                      {sc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* ── Account ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <Landmark className="size-5 text-muted-foreground shrink-0" />
            <Select
              value={accountId || "__none__"}
              onValueChange={(v) => setAccountId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5">
                <SelectValue>
                  {selectedAccount ? (
                    <span className="flex items-center gap-1.5">
                      {accountTheme && (
                        <span
                          className="inline-block size-4 rounded-full shrink-0"
                          style={{
                            background: `linear-gradient(135deg, ${accountTheme.from}, ${accountTheme.to})`,
                          }}
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
                {(accounts ?? []).map((a) => {
                  const t =
                    ACCOUNT_THEMES.find(
                      (th) => th.id === (a.theme ?? "default"),
                    ) ?? ACCOUNT_THEMES[0];
                  return (
                    <SelectItem key={a._id} value={a._id}>
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block size-3.5 rounded-full shrink-0"
                          style={{
                            background: `linear-gradient(135deg, ${t.from}, ${t.to})`,
                          }}
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
              className="flex items-center gap-1 py-3 text-sm font-semibold text-foreground hover:text-foreground/80 transition-colors w-full justify-end"
            >
              More details
              <ChevronDown className="size-4" />
            </button>
          )}

          {/* ── Extended fields (payee, note) ── */}
          {showMore && (
            <>
              {/* Payee */}
              <div className="flex items-center gap-3 border-b border-border py-3">
                <User className="size-5 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  value={payee}
                  onChange={(e) => setPayee(e.target.value)}
                  placeholder="Payee"
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Payee"
                />
              </div>

              {/* Note */}
              <div className="flex items-center gap-3 border-b border-border py-3">
                <StickyNote className="size-5 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note"
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  aria-label="Note"
                />
              </div>
            </>
          )}

          {/* ── Error ── */}
          {error && (
            <p className="mt-3 text-sm text-destructive">{error}</p>
          )}
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
            {isPending
              ? "Saving..."
              : isEdit
                ? "Save changes"
                : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
