import { Wifi, Eye, EyeOff, TrendingUp, TrendingDown } from "lucide-react";
import { useState } from "react";
import type { Account } from "@mpf/finance-contract";
import { formatMinor } from "@/lib/money";
import { ACCOUNT_THEMES } from "@/lib/accounts";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Resolve a theme ID (e.g. "laranja") to gradient colors. */
function resolveTheme(themeId?: string): { from: string; to: string } {
  const found = ACCOUNT_THEMES.find((t) => t.id === themeId);
  return found
    ? { from: found.from, to: found.to }
    : { from: "#163300", to: "#2f5711" }; // primary green fallback
}

/** Derive a 4-digit card number from the account ID for visual display. */
function deriveCardNumber(id: string): string {
  return id.slice(-4).toUpperCase();
}

/* -------------------------------------------------------------------------- */
/*  Account card component (bank card visual)                                 */
/* -------------------------------------------------------------------------- */

interface AccountCardProps {
  account: Account;
  holderName?: string;
}

function AccountCard({ account, holderName = "DALVA USER" }: AccountCardProps) {
  const [showBalance, setShowBalance] = useState(true);
  const theme = resolveTheme(account.theme);
  const cardNumber = deriveCardNumber(account.id);

  return (
    <div
      className="relative flex w-full flex-col justify-between overflow-hidden rounded-2xl p-4 text-white shadow-lg sm:p-5"
      style={{
        background: `linear-gradient(135deg, ${theme.from}, ${theme.to})`,
        aspectRatio: "1.6 / 1",
      }}
    >
      {/* Top row: Contactless + brand */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-white/20 backdrop-blur-sm sm:size-8">
            <Wifi className="size-3.5 rotate-90 sm:size-4" />
          </div>
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider opacity-80 sm:text-xs">
          {account.type.replace("_", " ")}
        </span>
      </div>

      {/* Middle: Balance inside card */}
      <div className="flex items-center gap-2">
        <p className="min-w-0 truncate text-2xl font-semibold tabular-nums tracking-tight sm:text-4xl lg:text-5xl">
          {showBalance
            ? formatMinor(account.balance.amountMinor, account.balance.currency)
            : "****"}
        </p>
        {account.balance.amountMinor < 0 && showBalance && (
            <span className="shrink-0 rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-medium">
              owing
            </span>
        )}
        <button
          onClick={() => setShowBalance(!showBalance)}
          className="ml-auto shrink-0 rounded-md p-1 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
          aria-label={showBalance ? "Hide balance" : "Show balance"}
        >
          {showBalance ? (
            <Eye className="size-4" />
          ) : (
            <EyeOff className="size-4" />
          )}
        </button>
      </div>

      {/* Bottom: Card number + holder + logo */}
      <div className="flex flex-col gap-1 min-w-0">
        <p className="truncate font-mono text-[10px] tracking-[0.22em] opacity-70 sm:text-sm sm:tracking-widest">
          **** **** **** {cardNumber}
        </p>
        <div className="flex items-end justify-between gap-2 min-w-0">
          <p className="truncate text-[10px] font-medium tracking-wider uppercase sm:text-xs">
            {holderName}
          </p>
          <span className="shrink-0 text-xs font-semibold opacity-60 sm:text-sm">DALVA</span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Account cards section (scrollable on mobile)                              */
/* -------------------------------------------------------------------------- */

interface AccountCardsSectionProps {
  accounts: Account[];
  /** This month's totals in the base currency (minor units); null while loading or when unavailable. */
  income: number | null;
  expenses: number | null;
  currency: string;
  holderName?: string;
}

export function AccountCardsSection({
  accounts,
  income,
  expenses,
  currency,
  holderName,
}: AccountCardsSectionProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  // An account can disappear (archived elsewhere) while its dot was selected.
  const shownIndex = Math.min(activeIndex, accounts.length - 1);
  const active = accounts[shownIndex];

  // Empty state when no accounts exist yet
  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-3 sm:gap-4">
        <h2 className="text-sm font-medium text-muted-foreground">
          My Accounts
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
          <div className="w-full sm:w-3/4">
            <div
               className="glass-surface flex w-full flex-col justify-between rounded-2xl border border-dashed border-border p-4 sm:p-5"
              style={{ aspectRatio: "1.6 / 1" }}
            >
              <div className="h-8 w-20 rounded-md bg-muted/70" />
              <div className="space-y-2">
                <div className="h-10 w-40 rounded-md bg-muted/70" />
                <div className="h-4 w-28 rounded-md bg-muted/50" />
              </div>
              <div className="space-y-2">
                <div className="h-4 w-32 rounded-md bg-muted/50" />
                <p className="text-xs text-muted-foreground">
                  Your first account will appear here.
                </p>
              </div>
            </div>
          </div>

          <div className="flex w-full flex-row gap-3 sm:w-1/4 sm:flex-col sm:gap-4">
            <div className="glass-surface flex flex-1 flex-col justify-center rounded-2xl p-3 sm:p-4">
              <div className="h-4 w-20 rounded-md bg-muted/50" />
              <div className="mt-2 h-7 w-24 rounded-md bg-muted/70" />
            </div>
            <div className="glass-surface flex flex-1 flex-col justify-center rounded-2xl p-3 sm:p-4">
              <div className="h-4 w-22 rounded-md bg-muted/50" />
              <div className="mt-2 h-7 w-24 rounded-md bg-muted/70" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          My Accounts
        </h2>
        <div className="flex gap-1">
          {accounts.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveIndex(i)}
              className={`size-2 rounded-full transition-colors ${
                i === shownIndex ? "bg-primary" : "bg-muted-foreground/30"
              }`}
              aria-label={`View account ${i + 1}`}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        {/* Account card — full width on mobile, 75% on sm+ */}
        <div className="w-full sm:w-3/4">
          {active && <AccountCard account={active} holderName={holderName} />}
        </div>

        {/* Income & Expenses summary — row on mobile, column on sm+ */}
        <div className="flex w-full flex-row gap-3 sm:w-1/4 sm:flex-col sm:gap-4">
          {/* Total Income */}
          <div className="glass-surface flex flex-1 flex-col items-center justify-center rounded-2xl p-3 sm:items-start sm:p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <TrendingUp className="size-4 text-emerald-500" />
              <span className="text-xs font-medium">Total Income</span>
            </div>
            <p className="mt-1.5 text-base font-semibold tabular-nums text-foreground sm:mt-2 sm:text-lg">
              {income === null ? "—" : formatMinor(income, currency)}
            </p>
          </div>

          {/* Total Expenses */}
          <div className="glass-surface flex flex-1 flex-col items-center justify-center rounded-2xl p-3 sm:items-start sm:p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <TrendingDown className="size-4 text-red-500" />
              <span className="text-xs font-medium">Total Expenses</span>
            </div>
            <p className="mt-1.5 text-base font-semibold tabular-nums text-foreground sm:mt-2 sm:text-lg">
              {expenses === null ? "—" : formatMinor(expenses, currency)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
