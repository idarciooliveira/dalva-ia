import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Goal } from "@mpf/finance-contract";
import { Calendar, Check, FileText, LinkIcon, Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CurrencyInput, parseCurrencyInput } from "@/components/ui/currency-input";
import { AccountPickerHint } from "@/components/account-picker-hint";
import { FormError } from "@/components/error-state";
import { DEFAULT_GOAL_COLOR } from "@/components/goals/goal-card";
import { useAuthProfile } from "@/hooks/use-auth-profile";
import { accountsForBaseCurrency } from "@/lib/accounts";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { accountsQuery } from "@/lib/api/queries";
import { getCurrencySymbol } from "@/lib/currencies";
import { fractionDigits, maskPlaceholder } from "@/lib/money";
import { cn } from "@/lib/utils";

interface GoalFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal: Goal | null;
}

const GOAL_COLORS = [
  { id: DEFAULT_GOAL_COLOR, label: "Lime", from: "#a3e635", to: "#65a30d" },
  { id: "#34d399", label: "Emerald", from: "#34d399", to: "#059669" },
  { id: "#38bdf8", label: "Sky", from: "#38bdf8", to: "#0284c7" },
  { id: "#a78bfa", label: "Violet", from: "#a78bfa", to: "#7c3aed" },
  { id: "#fb923c", label: "Orange", from: "#fb923c", to: "#ea580c" },
  { id: "#f472b6", label: "Pink", from: "#f472b6", to: "#db2777" },
  { id: "#fbbf24", label: "Amber", from: "#fbbf24", to: "#d97706" },
] as const;

/** Accounts a goal can be linked to (as under Convex), in the base currency. */
const LINKABLE_TYPES = ["savings", "bank"] as const;
const ERROR_ID = "goal-form-error";

export function GoalFormDialog({ open, onOpenChange, goal }: GoalFormDialogProps) {
  const isEdit = goal !== null;
  // Goals are in the base currency; the API labels their amounts with it.
  const currency = useAuthProfile().baseCurrency ?? "USD";
  const digits = fractionDigits(currency);

  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [isVirtual, setIsVirtual] = useState(true);
  const [linkedAccountId, setLinkedAccountId] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_GOAL_COLOR);
  const [error, setError] = useState("");

  // Only needed to pick the account of a new linked goal.
  const accountsResult = useQuery({ ...accountsQuery(), enabled: open && !isEdit });
  const { usable: linkableAccounts, otherCurrency } = accountsForBaseCurrency(
    accountsResult.data?.items ?? [],
    currency,
    LINKABLE_TYPES,
  );

  function reset(from: Goal | null) {
    setName(from?.name ?? "");
    setTargetAmount(from ? String(from.targetAmount.amountMinor) : "");
    setTargetDate(from?.targetDate ?? "");
    setIsVirtual(from?.isVirtual ?? true);
    setLinkedAccountId(from?.linkedAccountId ?? "");
    setColor(from?.color ?? DEFAULT_GOAL_COLOR);
    setError("");
  }

  // Keyed on the id: a refetch of the same goal while open keeps what was typed.
  const goalId = goal?.id;
  useEffect(() => {
    if (open) reset(goal);
  }, [open, goalId]);

  const { mutateAsync: createGoal, isPending: isCreating } = useApiMutation("goals", "create");
  const { mutateAsync: updateGoal, isPending: isUpdating } = useApiMutation("goals", "update");
  const isPending = isCreating || isUpdating;

  async function handleSubmit(andCreateNew = false) {
    if (isPending) return;
    setError("");

    if (!name.trim()) {
      setError("Goal name is required");
      return;
    }
    const amountMinor = parseCurrencyInput(targetAmount);
    if (Number.isNaN(amountMinor) || amountMinor <= 0) {
      setError("Please enter a valid target amount");
      return;
    }
    if (!isEdit && !isVirtual && !linkedAccountId) {
      setError("Please select an account to link to");
      return;
    }

    const target = { amountMinor, currency };
    try {
      if (isEdit) {
        // The date can be changed, not cleared (the API keeps the stored one when it's left out).
        await updateGoal({ id: goal.id, name: name.trim(), targetAmount: target, targetDate: targetDate || undefined, color });
        onOpenChange(false);
        return;
      }
      await createGoal({
        name: name.trim(),
        targetAmount: target,
        targetDate: targetDate || undefined,
        isVirtual,
        linkedAccountId: isVirtual ? undefined : linkedAccountId,
        color,
      });
      if (andCreateNew) reset(null);
      else onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, isEdit ? "Couldn't save the goal. Try again." : "Couldn't create the goal. Try again."));
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
          <DialogTitle className="text-lg font-semibold">{isEdit ? "Edit goal" : "New savings goal"}</DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? "Change the goal's name, target, date and color." : "Set a target and how to track it."}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit(false);
          }}
        >
          <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
            {/* ── Target amount: prominent on create, a regular row on edit ── */}
            {isEdit ? (
              <div className="flex items-center gap-3 border-b border-border py-3">
                <Target className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="flex flex-1 items-center gap-1">
                  <span className="text-sm text-muted-foreground">{symbol}</span>
                  <CurrencyInput
                    value={targetAmount}
                    onValueChange={setTargetAmount}
                    fractionDigits={digits}
                    placeholder={maskPlaceholder(digits)}
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    aria-label="Target amount"
                    {...invalidProps}
                  />
                </div>
              </div>
            ) : (
              <div className="mb-5">
                <div className="flex items-baseline gap-1 border-b-2 border-primary pb-2">
                  <span className="text-2xl font-semibold text-primary">{symbol}</span>
                  <CurrencyInput
                    value={targetAmount}
                    onValueChange={setTargetAmount}
                    fractionDigits={digits}
                    placeholder={maskPlaceholder(digits)}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                    aria-label="Target amount"
                    {...invalidProps}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Target amount</p>
              </div>
            )}

            {/* ── Name ── */}
            <div className="flex items-center gap-3 border-b border-border py-3">
              <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Goal name"
                autoFocus={isEdit}
                maxLength={100}
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                aria-label="Goal name"
                {...invalidProps}
              />
            </div>

            {/* ── Target date ── */}
            <div className="flex items-center gap-3 border-b border-border py-3">
              <Calendar className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground outline-none [color-scheme:inherit]"
                aria-label="Target date"
              />
            </div>

            {/* ── Tracking mode and linked account (create only: they can't change later) ── */}
            {!isEdit && (
              <div className="flex items-center gap-3 border-b border-border py-3">
                <LinkIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Select
                  value={isVirtual ? "virtual" : "linked"}
                  onValueChange={(v) => {
                    setIsVirtual(v === "virtual");
                    if (v === "virtual") setLinkedAccountId("");
                  }}
                >
                  <SelectTrigger
                    aria-label="Tracking mode"
                    className="h-auto w-full min-w-0 gap-1.5 rounded-full border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium shadow-none ring-0 focus:ring-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="virtual">Virtual tracking</SelectItem>
                    <SelectItem value="linked">Link to account</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {!isEdit && !isVirtual && (
              <div className="border-b border-border py-3 pl-8">
                <Select value={linkedAccountId} onValueChange={setLinkedAccountId}>
                  <SelectTrigger
                    aria-label="Linked account"
                    className="h-auto w-full min-w-0 border-0 bg-transparent px-2 py-0 text-left text-sm shadow-none ring-0 focus:ring-0"
                  >
                    <SelectValue placeholder="Select savings account" />
                  </SelectTrigger>
                  <SelectContent>
                    {linkableAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AccountPickerHint
                  loading={accountsResult.isPending}
                  error={accountsResult.isError}
                  empty={linkableAccounts.length === 0}
                  otherCurrency={otherCurrency}
                  currency={currency}
                  noun="savings or bank account"
                />
              </div>
            )}

            {/* ── Color ── */}
            <div className="border-b border-border py-3">
              <div className="mb-2.5 flex items-center gap-3">
                <div className="size-5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
                <span className="text-sm text-muted-foreground">Goal color</span>
              </div>
              <div className="flex flex-wrap gap-2 pl-8 sm:gap-2.5">
                {GOAL_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setColor(c.id)}
                    className={cn(
                      "relative size-9 rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      color === c.id && "scale-110",
                    )}
                    style={{ background: `linear-gradient(135deg, ${c.from}, ${c.to})` }}
                    title={c.label}
                    aria-label={`Color: ${c.label}`}
                    aria-pressed={color === c.id}
                  >
                    {color === c.id && <Check className="absolute inset-0 m-auto size-4 text-white drop-shadow-md" />}
                  </button>
                ))}
              </div>
            </div>

            <FormError id={ERROR_ID} message={error} />
          </div>

          <div className="mt-2 flex flex-col-reverse gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3 sm:px-5">
            {!isEdit && (
              <Button
                type="button"
                variant="outline"
                size="default"
                className="w-full sm:w-auto"
                disabled={isPending || !name.trim()}
                onClick={() => void handleSubmit(true)}
              >
                {isPending ? "Saving..." : "Save & new"}
              </Button>
            )}
            <Button type="submit" variant="accent" size="default" className="w-full sm:w-auto" disabled={isPending || !name.trim()}>
              {isPending ? "Saving..." : isEdit ? "Save changes" : "Create goal"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

