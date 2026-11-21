import { Landmark, Plus, Trash2, ArrowRight, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { getCurrencySymbol } from "@/lib/currencies";
import {
  ACCOUNT_TYPES,
  ACCOUNT_THEMES,
  createAccountDraft,
  type AccountDraft,
  type AccountType,
} from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StepHeader } from "./step-header";

export function AccountsStep({
  accounts,
  onAccountsChange,
  currency,
  onNext,
  onBack,
  isSubmitting,
}: {
  accounts: AccountDraft[];
  onAccountsChange: (accounts: AccountDraft[]) => void;
  currency: string;
  onNext: () => void;
  onBack: () => void;
  isSubmitting: boolean;
}) {
  const currencySymbol = getCurrencySymbol(currency);

  function updateAccount(id: string, updates: Partial<AccountDraft>) {
    onAccountsChange(
      accounts.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    );
  }

  function addAccount() {
    onAccountsChange([...accounts, createAccountDraft()]);
  }

  function removeAccount(id: string) {
    if (accounts.length <= 1) return;
    onAccountsChange(accounts.filter((a) => a.id !== id));
  }

  const hasValidAccount = accounts.some((a) => a.name.trim().length > 0);

  return (
    <div className="space-y-6">
      <StepHeader
        icon={Landmark}
        title="Add your accounts"
        subtitle="Create at least one financial account to start tracking."
      />

      <div className="space-y-4">
        {accounts.map((account, index) => (
          <AccountRow
            key={account.id}
            account={account}
            index={index}
            currencySymbol={currencySymbol}
            canRemove={accounts.length > 1}
            onUpdate={(updates) => updateAccount(account.id, updates)}
            onRemove={() => removeAccount(account.id)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addAccount}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <Plus className="size-4" />
        Add another account
      </button>

      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={onBack} disabled={isSubmitting}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button
          variant="accent"
          className="flex-1"
          onClick={onNext}
          disabled={isSubmitting || !hasValidAccount}
        >
          {isSubmitting ? "Saving..." : "Continue"}
          {!isSubmitting && <ArrowRight className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Account row                                                               */
/* -------------------------------------------------------------------------- */

function AccountRow({
  account,
  index,
  currencySymbol,
  canRemove,
  onUpdate,
  onRemove,
}: {
  account: AccountDraft;
  index: number;
  currencySymbol: string;
  canRemove: boolean;
  onUpdate: (updates: Partial<AccountDraft>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Account {index + 1}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground transition-colors hover:text-destructive"
            aria-label="Remove account"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor={`account-name-${account.id}`} className="text-xs">
          Account name
        </Label>
        <Input
          id={`account-name-${account.id}`}
          placeholder="e.g. Main Bank"
          value={account.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="h-10 rounded-lg px-3"
        />
      </div>

      {/* Type */}
      <div className="space-y-1.5">
        <Label htmlFor={`account-type-${account.id}`} className="text-xs">
          Type
        </Label>
        <Select
          value={account.type}
          onValueChange={(v) => onUpdate({ type: v as AccountType })}
        >
          <SelectTrigger
            id={`account-type-${account.id}`}
            size="sm"
            className="w-full"
          >
            <SelectValue />
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

      {/* Theme */}
      <div className="space-y-1.5">
        <Label className="text-xs">Color theme</Label>
        <div className="flex items-center gap-2">
          {ACCOUNT_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onUpdate({ theme: t.id })}
              className={cn(
                "size-7 rounded-full border-2 transition-all",
                account.theme === t.id
                  ? "border-foreground scale-110"
                  : "border-transparent hover:scale-105",
              )}
              style={{
                background: `linear-gradient(135deg, ${t.from}, ${t.to})`,
              }}
              aria-label={t.label}
              title={t.label}
            />
          ))}
        </div>
      </div>

      {/* Balance */}
      <div className="space-y-1.5">
        <Label htmlFor={`account-balance-${account.id}`} className="text-xs">
          Opening balance ({currencySymbol})
        </Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {currencySymbol}
          </span>
          <Input
            id={`account-balance-${account.id}`}
            type="number"
            step="0.01"
            placeholder="0.00"
            value={account.balance}
            onChange={(e) => onUpdate({ balance: e.target.value })}
            className="h-10 rounded-lg pl-10 pr-3"
          />
        </div>
      </div>
    </div>
  );
}
