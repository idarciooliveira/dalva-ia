/* -------------------------------------------------------------------------- */
/*  Dashboard card data types, plus mock data for the budget card until       */
/*  budgets exist in the API.                                                  */
/* -------------------------------------------------------------------------- */

export interface NetWorthData {
  hasData: boolean;
  totalAssets: number; // cents
  totalDebts: number; // cents
  netWorth: number; // cents
  currency: string;
}

export interface BudgetItem {
  id: string;
  category: string;
  limit: number; // cents
  spent: number; // cents
  status: "on_track" | "approaching" | "over";
}

export interface BudgetSummaryData {
  budgets: BudgetItem[];
  onTrack: number;
  approaching: number;
  over: number;
  currency: string;
}

export interface GoalItem {
  id: string;
  name: string;
  targetAmount: number; // cents
  currentAmount: number; // cents
  percentComplete: number;
  targetDate?: string; // ISO date
}

export interface GoalsProgressData {
  goals: GoalItem[];
  currency: string;
}

export interface DebtItem {
  id: string;
  name: string;
  creditor: string;
  originalAmount: number; // cents
  currentBalance: number; // cents
  percentPaid: number;
  minimumPayment?: number; // cents
}

export interface DebtPaydownData {
  debts: DebtItem[];
  totalRemaining: number; // cents
  totalOriginal: number; // cents
  recentPayment: number; // cents
  currency: string;
}

export const mockBudgetSummary: BudgetSummaryData = {
  budgets: [
    {
      id: "bgt-1",
      category: "Food",
      limit: 80_000,
      spent: 65_000,
      status: "approaching",
    },
    {
      id: "bgt-2",
      category: "Transport",
      limit: 50_000,
      spent: 42_500,
      status: "approaching",
    },
    {
      id: "bgt-3",
      category: "Shopping",
      limit: 60_000,
      spent: 38_000,
      status: "on_track",
    },
    {
      id: "bgt-4",
      category: "Utilities",
      limit: 30_000,
      spent: 32_000,
      status: "over",
    },
    {
      id: "bgt-5",
      category: "Entertainment",
      limit: 40_000,
      spent: 15_000,
      status: "on_track",
    },
  ],
  onTrack: 2,
  approaching: 2,
  over: 1,
  currency: "USD",
};

export { formatCurrency } from "./format";
