import { useEffect, useState } from "react";
import {
  Landmark,
  FileText,
  Palette,
  Check,
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
import { FormError } from "@/components/error-state";
import { useAuthProfile } from "@/hooks/use-auth-profile";
import { useApiMutation } from "@/lib/api/mutations";
import type { Account } from "@/lib/api/types";
import { apiErrorMessage } from "@/lib/api/errors";
import { fractionDigits, maskPlaceholder } from "@/lib/money";
import { ACCOUNT_TYPES, ACCOUNT_THEMES, type AccountType } from "@/lib/accounts";
import { CURRENCIES, getCurrencySymbol } from "@/lib/currencies";
import { CurrencyFlag } from "@/components/currency-flag";
import { cn } from "@/lib/utils";

interface AccountFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: Account | null;
}

export function AccountFormDialog({
  open,
  onOpenChange,
  account,
}: AccountFormDialogProps) {
  const isEdit = account !== null;
  // New accounts default to the base currency chosen in onboarding.
  const defaultCurrency = useAuthProfile().baseCurrency ?? "USD";

  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("bank");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [theme, setTheme] = useState("default");
  const [balance, setBalance] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (account) {
      setName(account.name);
      setType(account.type);
      setCurrency(account.balance.currency);
      setTheme(account.theme ?? "default");
      setBalance("");
    } else {
      setName("");
      setType("bank");
      setCurrency(defaultCurrency);
      setTheme("default");
      setBalance("");
    }
    setError("");
  }, [account, open, defaultCurrency]);

  const { mutateAsync: createAccount, isPending: isCreating } = useApiMutation("accounts", "create");
  const { mutateAsync: updateAccount, isPending: isUpdating } = useApiMutation("accounts", "update");

  const isPending = isCreating || isUpdating;

  async function handleSubmit(andCreateNew = false) {
    setError("");

    if (!name.trim()) {
      setError("Account name is required");
      return;
    }

    try {
      if (isEdit && account) {
        await updateAccount({
          id: account.id,
          name: name.trim(),
          type,
          theme,
        });
        onOpenChange(false);
        return;
      }

      const amountMinor = parseCurrencyInput(balance);
      if (Number.isNaN(amountMinor)) {
        setError("Please enter a valid balance");
        return;
      }
      await createAccount({
        name: name.trim(),
        type,
        balance: { amountMinor, currency },
        theme,
      });

      if (andCreateNew) {
        // Reset form for another entry
        setName("");
        setType("bank");
        setCurrency(defaultCurrency);
        setTheme("default");
        setBalance("");
        setError("");
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError(apiErrorMessage(err, isEdit ? "Couldn't save the account. Try again." : "Couldn't create the account. Try again."));
    }
  }

  const currencyInfo = CURRENCIES.find((c) => c.code === currency);
  const currencySymbol = getCurrencySymbol(currency);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        {/* Header */}
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">
            {isEdit ? "Edit account" : "New account"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? "Change the account's name, type and color." : "Create an account with its opening balance."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4">
          {/* ── Balance input (prominent, top) ── */}
          {!isEdit && (
            <div className="mb-5">
              <div className="flex items-baseline gap-1 border-b-2 border-primary pb-2">
                <span className="text-2xl font-semibold text-primary">
                  {currencySymbol}
                </span>
                <CurrencyInput
                  value={balance}
                  onValueChange={setBalance}
                  fractionDigits={fractionDigits(currency)}
                  allowNegative
                  placeholder={maskPlaceholder(fractionDigits(currency))}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
                  aria-label="Opening balance"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "account-form-error" : undefined}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Opening balance</p>
            </div>
          )}

          {/* ── Name field (icon-led row with bottom border) ── */}
           <div className="flex items-center gap-3 border-b border-border py-3">
            <FileText className="size-5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Account name"
              autoFocus={isEdit}
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Account name"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "account-form-error" : undefined}
            />
          </div>

          {/* ── Type field (icon-led row with pill selector) ── */}
          <div className="flex items-center gap-3 border-b border-border py-3">
            <Landmark className="size-5 text-muted-foreground shrink-0" />
            <Select value={type} onValueChange={(v) => setType(v as AccountType)}>
              <SelectTrigger aria-label="Account type" className="h-auto w-full min-w-0 border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium rounded-full shadow-none ring-0 focus:ring-0 gap-1.5">
                <SelectValue>
                  {(() => {
                    const typeInfo = ACCOUNT_TYPES.find((t) => t.value === type);
                    const Icon = typeInfo?.icon;
                    return (
                      <span className="flex items-center gap-1.5">
                        {Icon && <Icon className="size-3.5" />}
                        {typeInfo?.label ?? type}
                      </span>
                    );
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    <div className="flex items-center gap-2">
                      <t.icon className="size-4" />
                      {t.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ── Currency field (create only, icon-led row) ── */}
          {!isEdit && (
            <div className="flex items-center gap-3 border-b border-border py-3">
              <span className="text-base text-muted-foreground shrink-0 w-5 text-center font-medium">
                {currencyInfo ? <CurrencyFlag country={currencyInfo.country} className="mx-auto" /> : "$"}
              </span>
              <Select
                value={currency}
                onValueChange={(next) => {
                  setCurrency(next);
                  // The typed digits mean a different amount at another precision (USD 1.500,50 -> JPY 150.050).
                  if (fractionDigits(next) !== fractionDigits(currency)) setBalance("");
                }}
              >
             <SelectTrigger aria-label="Currency" className="h-auto w-full min-w-0 border-0 bg-transparent px-2 py-0 text-left text-sm shadow-none ring-0 focus:ring-0">
                  <SelectValue>
                    {currencyInfo
                      ? `${currencyInfo.code} — ${currencyInfo.name}`
                      : currency}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      <CurrencyFlag country={c.country} /> {c.code} — {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* ── Theme/color field (icon-led row with color swatches) ── */}
          <div className="border-b border-border py-3">
            <div className="flex items-center gap-3 mb-2.5">
              <Palette className="size-5 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">Account color</span>
            </div>
             <div className="flex flex-wrap gap-2 pl-8 sm:gap-2.5">
              {ACCOUNT_THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    "relative size-9 rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    theme === t.id && "scale-110",
                  )}
                  style={{
                    background: `linear-gradient(135deg, ${t.from}, ${t.to})`,
                  }}
                  title={t.label}
                  aria-label={`Theme: ${t.label}`}
                  aria-pressed={theme === t.id}
                >
                  {theme === t.id && (
                    <Check className="absolute inset-0 m-auto size-4 text-white drop-shadow-md" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* ── Error ── */}
          <FormError id="account-form-error" message={error} />
        </div>

        {/* ── Footer with actions ── */}
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
            <Button
              type="button"
              variant="accent"
              size="default"
              className="w-full sm:w-auto"
              disabled={isPending || !name.trim()}
              onClick={() => void handleSubmit(false)}
            >
            {isPending
              ? "Saving..."
              : isEdit
                ? "Save changes"
                : "Create account"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
