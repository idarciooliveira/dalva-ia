import type { Debt } from "@mpf/finance-contract";

export const DEBT_TYPES = [
  { value: "credit_card", label: "Credit card" },
  { value: "loan", label: "Loan" },
  { value: "mortgage", label: "Mortgage" },
  { value: "student_loan", label: "Student loan" },
  { value: "personal_loan", label: "Personal loan" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<{ value: Debt["debtType"]; label: string }>;

export function debtTypeLabel(type: Debt["debtType"]): string {
  return DEBT_TYPES.find((t) => t.value === type)?.label ?? type;
}

/** Paid off as a whole percentage of the original amount, 0..100. */
export function debtPercentPaid(debt: Pick<Debt, "originalAmount" | "currentBalance">): number {
  const original = debt.originalAmount.amountMinor;
  if (original <= 0) return 0;
  const paid = Math.round(((original - debt.currentBalance.amountMinor) / original) * 100);
  return Math.max(0, Math.min(100, paid));
}

/**
 * Principal and interest of a payment, in minor units; `null` for a blank
 * field. The API needs them to add up to the amount, so a blank one is the
 * rest of the payment; both blank is all principal (the API's default).
 */
export function splitPayment(
  amount: number,
  principal: number | null,
  interest: number | null,
): { principal: number; interest: number } | { error: string } {
  if (principal === null && interest === null) return { principal: amount, interest: 0 };
  const p = principal ?? amount - (interest ?? 0);
  const i = interest ?? amount - p;
  if (p < 0 || i < 0) return { error: "Principal and interest can't be more than the payment amount" };
  if (p + i !== amount) return { error: "Principal and interest must add up to the payment amount" };
  return { principal: p, interest: i };
}

/** "24.99" or "24,99" → 24.99; `null` for blank; NaN when it isn't a rate. */
export function parseInterestRate(input: string): number | null {
  const value = input.trim().replace(",", ".");
  if (value === "") return null;
  if (!/^\d+(\.\d+)?$/.test(value)) return Number.NaN;
  return Number(value);
}
