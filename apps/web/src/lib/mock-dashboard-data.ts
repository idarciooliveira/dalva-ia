/* -------------------------------------------------------------------------- */
/*  Mock dashboard data                                                       */
/*  Replace with real Convex queries when features are built.                 */
/* -------------------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NetWorthData {
  hasData: boolean;
  totalAssets: number; // cents
  totalDebts: number; // cents
  netWorth: number; // cents
  currency: string;
}

export interface CashflowMonth {
  month: string; // e.g. "Jan", "Feb"
  income: number; // cents
  expenses: number; // cents
}

export interface CashflowData {
  currentMonth: {
    income: number;
    expenses: number;
    net: number;
  };
  trend: CashflowMonth[]; // last 6 months
  currency: string;
}

export interface CategorySpending {
  name: string;
  amount: number; // cents
  fill: string; // chart color CSS variable
}

export interface SpendingByCategoryData {
  categories: CategorySpending[];
  total: number; // cents
  currency: string;
}

export interface RecentTransaction {
  id: string;
  date: string; // ISO date
  description: string;
  category: string;
  amount: number; // cents (negative = expense, positive = income)
  type: "income" | "expense" | "adjustment" | "transfer";
  account: string;
}

export interface RecentTransactionsData {
  transactions: RecentTransaction[];
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

export interface AccountCardData {
  name: string;
  type: string;
  balance: number; // cents
  currency: string;
  cardNumber: string; // last 4 digits
  holderName: string;
  theme: {
    from: string;
    to: string;
  };
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

export const mockNetWorth: NetWorthData = {
  hasData: true,
  totalAssets: 3_285_000, // $32,850.00
  totalDebts: 800_000, // $8,000.00
  netWorth: 2_485_000, // $24,850.00
  currency: "USD",
};

export const mockCashflow: CashflowData = {
  currentMonth: {
    income: 520_000, // $5,200.00
    expenses: 347_500, // $3,475.00
    net: 172_500, // $1,725.00
  },
  trend: [
    { month: "Nov", income: 480_000, expenses: 390_000 },
    { month: "Dec", income: 510_000, expenses: 420_000 },
    { month: "Jan", income: 490_000, expenses: 360_000 },
    { month: "Feb", income: 500_000, expenses: 380_000 },
    { month: "Mar", income: 520_000, expenses: 350_000 },
    { month: "Apr", income: 520_000, expenses: 347_500 },
  ],
  currency: "USD",
};

export const mockSpendingByCategory: SpendingByCategoryData = {
  categories: [
    { name: "Housing", amount: 120_000, fill: "var(--color-chart-1)" },
    { name: "Food", amount: 65_000, fill: "var(--color-chart-2)" },
    { name: "Transport", amount: 42_500, fill: "var(--color-chart-3)" },
    { name: "Shopping", amount: 38_000, fill: "var(--color-chart-4)" },
    { name: "Utilities", amount: 32_000, fill: "var(--color-chart-5)" },
    { name: "Other", amount: 50_000, fill: "var(--color-muted-foreground)" },
  ],
  total: 347_500,
  currency: "USD",
};

export const mockRecentTransactions: RecentTransactionsData = {
  transactions: [
    {
      id: "txn-1",
      date: "2026-04-05",
      description: "Monthly Salary",
      category: "Salary",
      amount: 520_000,
      type: "income",
      account: "Main Bank",
    },
    {
      id: "txn-2",
      date: "2026-04-04",
      description: "Grocery Store",
      category: "Food",
      amount: -8_750,
      type: "expense",
      account: "Main Bank",
    },
    {
      id: "txn-3",
      date: "2026-04-03",
      description: "Electric Bill",
      category: "Utilities",
      amount: -14_500,
      type: "expense",
      account: "Main Bank",
    },
    {
      id: "txn-4",
      date: "2026-04-02",
      description: "Transfer to Savings",
      category: "Transfer",
      amount: -50_000,
      type: "transfer",
      account: "Main Bank",
    },
    {
      id: "txn-5",
      date: "2026-04-01",
      description: "Rent Payment",
      category: "Housing",
      amount: -120_000,
      type: "expense",
      account: "Main Bank",
    },
    {
      id: "txn-6",
      date: "2026-03-31",
      description: "Freelance Project",
      category: "Freelance",
      amount: 85_000,
      type: "income",
      account: "Main Bank",
    },
    {
      id: "txn-7",
      date: "2026-03-30",
      description: "Gas Station",
      category: "Transport",
      amount: -5_200,
      type: "expense",
      account: "Cash",
    },
  ],
  currency: "USD",
};

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

export const mockGoalsProgress: GoalsProgressData = {
  goals: [
    {
      id: "goal-1",
      name: "Emergency Fund",
      targetAmount: 1_000_000,
      currentAmount: 650_000,
      percentComplete: 65,
      targetDate: "2026-12-31",
    },
    {
      id: "goal-2",
      name: "Vacation",
      targetAmount: 300_000,
      currentAmount: 120_000,
      percentComplete: 40,
      targetDate: "2026-08-01",
    },
    {
      id: "goal-3",
      name: "New Laptop",
      targetAmount: 200_000,
      currentAmount: 180_000,
      percentComplete: 90,
      targetDate: "2026-05-15",
    },
  ],
  currency: "USD",
};

export const mockDebtPaydown: DebtPaydownData = {
  debts: [
    {
      id: "debt-1",
      name: "Student Loan",
      creditor: "Federal Aid",
      originalAmount: 2_500_000,
      currentBalance: 600_000,
      percentPaid: 76,
      minimumPayment: 25_000,
    },
    {
      id: "debt-2",
      name: "Credit Card",
      creditor: "Visa",
      originalAmount: 500_000,
      currentBalance: 200_000,
      percentPaid: 60,
      minimumPayment: 5_000,
    },
  ],
  totalRemaining: 800_000,
  totalOriginal: 3_000_000,
  recentPayment: 30_000,
  currency: "USD",
};

export const mockAccounts: AccountCardData[] = [
  {
    name: "Main Account",
    type: "bank",
    balance: 2_485_000,
    currency: "USD",
    cardNumber: "4821",
    holderName: "DALVA USER",
    theme: { from: "#163300", to: "#2f5711" },
  },
  {
    name: "Savings",
    type: "savings",
    balance: 650_000,
    currency: "USD",
    cardNumber: "7392",
    holderName: "DALVA USER",
    theme: { from: "#003B8E", to: "#0066CC" },
  },
  {
    name: "Credit Card",
    type: "credit_card",
    balance: -200_000,
    currency: "USD",
    cardNumber: "1158",
    holderName: "DALVA USER",
    theme: { from: "#8B6914", to: "#D4A843" },
  },
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Re-exported from lib/format.ts for backward compatibility.
// Prefer importing directly from "@/lib/format" in new code.
export { formatCurrency, formatCurrencyCompact, formatDate } from "./format";
