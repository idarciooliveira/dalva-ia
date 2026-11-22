import {
  Landmark,
  PiggyBank,
  CreditCard,
  Banknote,
  Smartphone,
  TrendingUp,
  Wallet,
} from "lucide-react";

export const ACCOUNT_TYPES = [
  { value: "bank", label: "Bank", icon: Landmark },
  { value: "savings", label: "Savings", icon: PiggyBank },
  { value: "credit_card", label: "Credit Card", icon: CreditCard },
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "e_wallet", label: "E-Wallet", icon: Smartphone },
  { value: "investment", label: "Investment", icon: TrendingUp },
  { value: "loan", label: "Loan", icon: Wallet },
] as const;

export const ACCOUNT_THEMES = [
  { id: "default", label: "Default", from: "#9CA3AF", to: "#6B7280" },
  { id: "laranja", label: "Laranja", from: "#F37021", to: "#F9A825" },
  { id: "azul", label: "Azul", from: "#003B8E", to: "#0066CC" },
  { id: "vermelho", label: "Vermelho", from: "#CC0000", to: "#E53935" },
  { id: "verde", label: "Verde", from: "#006B3F", to: "#43A047" },
  { id: "dourado", label: "Dourado", from: "#8B6914", to: "#D4A843" },
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number]["value"];

export interface AccountDraft {
  id: string; // client-side key
  name: string;
  type: AccountType;
  balance: string; // string for input, converted to cents on submit
  theme: string; // visual theme id
}

/**
 * Create a fresh AccountDraft with sensible defaults.
 */
export function createAccountDraft(
  overrides?: Partial<AccountDraft>,
): AccountDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: "bank",
    balance: "",
    theme: "default",
    ...overrides,
  };
}

/**
 * Accounts a goal or debt can move money on: goals and debts are in the base
 * currency, and the API refuses an account in another one (`validation_failed`).
 * `types` narrows the list further (savings accounts for a goal, liabilities for a debt).
 */
export function accountsForBaseCurrency<A extends { type: string; balance: { currency: string } }>(
  accounts: readonly A[],
  baseCurrency: string,
  types?: readonly string[],
): { usable: A[]; otherCurrency: number } {
  const ofType = types ? accounts.filter((a) => types.includes(a.type)) : accounts;
  const usable = ofType.filter((a) => a.balance.currency === baseCurrency);
  return { usable, otherCurrency: ofType.length - usable.length };
}
