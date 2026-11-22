import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAuthProfile } from "@/hooks/use-auth-profile";
import { AccountCardsSection } from "@/components/dashboard/account-card";
import { NetWorthCard } from "@/components/dashboard/net-worth-card";
import { CashflowCard } from "@/components/dashboard/cashflow-card";
import { SpendingCategoryCard } from "@/components/dashboard/spending-category-card";
import { RecentTransactionsCard } from "@/components/dashboard/recent-transactions-card";
import { BudgetSummaryCard } from "@/components/dashboard/budget-summary-card";
import { GoalsProgressCard } from "@/components/dashboard/goals-progress-card";
import { DebtPaydownCard } from "@/components/dashboard/debt-paydown-card";
import { cardStatus } from "@/components/dashboard/card-error";
import { accountsQuery, categoriesQuery } from "@/lib/api/queries";
import {
  dashboardGoalsQuery,
  debtSummaryQuery,
  netWorthQuery,
  transactionSummaryQuery,
} from "@/lib/api/dashboard";
import { buildRecentTransactions } from "@/lib/dashboard-data";
import type { DebtPaydownData, GoalsProgressData, NetWorthData } from "@/lib/mock-dashboard-data";

// Budgets have no backend module yet: this card stays on mock data.
import { mockBudgetSummary } from "@/lib/mock-dashboard-data";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

function DashboardPage() {
  const profile = useAuthProfile();
  const greeting = getGreeting();
  const firstName = profile.name?.split(" ")[0] ?? "there";
  // Reports, goals and debts are in the base currency.
  const baseCurrency = profile.baseCurrency ?? "USD";
  const currentMonth = getCurrentMonth();

  const accountsResult = useQuery(accountsQuery());
  // Names for the recent rows: archived accounts and categories included.
  const allAccountsResult = useQuery(accountsQuery({ includeArchived: true }));
  const categoriesResult = useQuery(categoriesQuery({ includeArchived: true }));
  const summaryResult = useQuery(transactionSummaryQuery(currentMonth));
  const netWorthResult = useQuery(netWorthQuery());
  const goalsResult = useQuery(dashboardGoalsQuery());
  const debtsResult = useQuery(debtSummaryQuery());

  const summary = summaryResult.data;
  const recentTransactions = useMemo(
    () =>
      buildRecentTransactions(
        summary?.recentTransactions ?? [],
        new Map<string, string>((allAccountsResult.data?.items ?? []).map((a) => [a.id, a.name])),
        new Map<string, string>((categoriesResult.data?.items ?? []).map((c) => [c.id, c.name])),
      ),
    [summary, allAccountsResult.data, categoriesResult.data],
  );

  const netWorth: NetWorthData = netWorthResult.data
    ? {
        hasData: netWorthResult.data.hasData,
        totalAssets: netWorthResult.data.totalAssets.amountMinor,
        totalDebts: netWorthResult.data.totalDebts.amountMinor,
        netWorth: netWorthResult.data.netWorth.amountMinor,
        currency: netWorthResult.data.netWorth.currency,
      }
    : { hasData: false, totalAssets: 0, totalDebts: 0, netWorth: 0, currency: baseCurrency };

  const goalsProgress: GoalsProgressData = {
    goals: (goalsResult.data?.items ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      targetAmount: g.targetAmount.amountMinor,
      currentAmount: g.currentAmount.amountMinor,
      percentComplete:
        g.targetAmount.amountMinor > 0
          ? Math.min(100, Math.round((g.currentAmount.amountMinor / g.targetAmount.amountMinor) * 100))
          : 0,
      targetDate: g.targetDate,
    })),
    currency: baseCurrency,
  };

  const debts = debtsResult.data;
  const debtPaydown: DebtPaydownData = debts
    ? {
        debts: debts.debts.map((d) => ({
          id: d.id,
          name: d.name,
          creditor: d.creditor,
          originalAmount: d.originalAmount.amountMinor,
          currentBalance: d.currentBalance.amountMinor,
          percentPaid: Math.max(0, Math.min(100, d.percentPaid)),
        })),
        totalRemaining: debts.totalRemaining.amountMinor,
        totalOriginal: debts.totalOriginal.amountMinor,
        recentPayment: debts.recentPayment.amountMinor,
        currency: debts.totalOriginal.currency,
      }
    : { debts: [], totalRemaining: 0, totalOriginal: 0, recentPayment: 0, currency: baseCurrency };

  return (
    <div className="dashboard-glass-bg dashboard-glass flex-1 overflow-auto">
      <div className="mx-auto max-w-300 px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
        {/* Greeting */}
        <div className="mb-4 sm:mb-6">
          <h1 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">
            {greeting}, {firstName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Here&apos;s your financial overview.</p>
        </div>

        {/* ============================================================ */}
        {/*  MAIN TWO-COLUMN LAYOUT                                      */}
        {/*  Left: Account card + Recent transactions                    */}
        {/*  Right: Spending by category chart + details                 */}
        {/* ============================================================ */}
        <div className="grid gap-4 sm:gap-5 lg:grid-cols-[1fr_380px] lg:gap-6">
          {/* --- Left column --- */}
          <div className="flex flex-col gap-4 sm:gap-5 lg:gap-6">
            <AccountCardsSection
              accounts={accountsResult.data?.items ?? []}
              income={summary ? summary.totalIncome.amountMinor : null}
              expenses={summary ? summary.totalExpenses.amountMinor : null}
              currency={summary?.totalIncome.currency ?? baseCurrency}
              holderName={profile.name?.toUpperCase() ?? "DALVA USER"}
            />
            <RecentTransactionsCard transactions={recentTransactions} status={cardStatus(summaryResult)} />
          </div>

          {/* --- Right column --- */}
          <div className="flex flex-col gap-4 sm:gap-5 lg:gap-6">
            <SpendingCategoryCard month={currentMonth} />
            <CashflowCard month={currentMonth} />
          </div>
        </div>

        {/* ============================================================ */}
        {/*  BOTTOM ROW: All remaining widgets                           */}
        {/* ============================================================ */}
        <div className="mt-4 grid gap-3 sm:mt-6 sm:gap-4 sm:grid-cols-2">
          <NetWorthCard data={netWorth} status={cardStatus(netWorthResult)} />
          <BudgetSummaryCard data={mockBudgetSummary} />
        </div>
        <div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4 sm:grid-cols-2">
          <GoalsProgressCard data={goalsProgress} status={cardStatus(goalsResult)} />
          <DebtPaydownCard data={debtPaydown} status={cardStatus(debtsResult)} />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Returns the current month in "YYYY-MM" format. */
function getCurrentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
