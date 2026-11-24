import type { Debt, DebtType } from "@/lib/api/types";

export const DEBT_TYPES = [
  { value: "credit_card", label: "Credit card" },
  { value: "loan", label: "Loan" },
  { value: "mortgage", label: "Mortgage" },
  { value: "student_loan", label: "Student loan" },
  { value: "personal_loan", label: "Personal loan" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<{ value: DebtType; label: string }>;

export function debtTypeLabel(type: DebtType): string {
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

type Money = { amountMinor: number; currency: string };

/** A debt as the form builds it: blank optional fields are `undefined`. */
export interface DebtFormFields {
  name: string;
  debtType: DebtType;
  originalAmount: Money;
  currentBalance: Money;
  lender?: string;
  interestRate?: number;
  minimumPayment?: Money;
  dueDate?: string;
  linkedAccountId?: string;
}

/**
 * Fields the form left blank that the debt has: the API can change them, not
 * clear them, so the form refuses rather than closing as if they were saved.
 */
export function clearedDebtFields(opened: Debt, fields: DebtFormFields): string[] {
  return [
    opened.lender !== undefined && fields.lender === undefined && "lender",
    opened.interestRate !== undefined && fields.interestRate === undefined && "interest rate",
    opened.minimumPayment !== undefined && fields.minimumPayment === undefined && "minimum payment",
    opened.dueDate !== undefined && fields.dueDate === undefined && "due date",
  ].filter((field): field is string => typeof field === "string");
}

/**
 * Current balance above the original amount: refused, except on an edit that
 * changes neither (a legacy debt can hold more and must stay editable).
 */
export function exceedsOriginal(opened: Debt | null, fields: DebtFormFields): boolean {
  const unchanged =
    opened !== null &&
    fields.originalAmount.amountMinor === opened.originalAmount.amountMinor &&
    fields.currentBalance.amountMinor === opened.currentBalance.amountMinor;
  return !unchanged && fields.currentBalance.amountMinor > fields.originalAmount.amountMinor;
}

/**
 * The update for an edit: only the fields that differ from the debt as the
 * dialog opened with it, so a payment recorded meanwhile (another tab, the bot)
 * isn't undone by sending the old balance back. `null` when nothing changed.
 */
export function debtChanges(opened: Debt, fields: DebtFormFields): Partial<DebtFormFields> | null {
  const value = <T>(next: T | undefined, stored: T | undefined) => (next !== stored ? next : undefined);
  const money = (next: Money | undefined, stored: Money | undefined) =>
    next !== undefined && next.amountMinor !== stored?.amountMinor ? next : undefined;
  const changes: Partial<DebtFormFields> = {
    name: value(fields.name, opened.name),
    debtType: value(fields.debtType, opened.debtType),
    originalAmount: money(fields.originalAmount, opened.originalAmount),
    currentBalance: money(fields.currentBalance, opened.currentBalance),
    lender: value(fields.lender, opened.lender),
    interestRate: value(fields.interestRate, opened.interestRate),
    minimumPayment: money(fields.minimumPayment, opened.minimumPayment),
    dueDate: value(fields.dueDate, opened.dueDate),
    // Unchanged: not re-checked by the API, so an archived linked account doesn't block other edits.
    linkedAccountId: value(fields.linkedAccountId, opened.linkedAccountId),
  };
  return Object.values(changes).some((v) => v !== undefined) ? changes : null;
}
