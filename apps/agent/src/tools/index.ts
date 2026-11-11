import { getCashflow } from "./get-cashflow";
import { getNetWorth } from "./get-net-worth";
import { getSpendingByCategory } from "./get-spending-by-category";
import { getTransactionSummary } from "./get-transaction-summary";
import { listAccounts } from "./list-accounts";
import { listCategories } from "./list-categories";
import { listDebts } from "./list-debts";
import { listGoals } from "./list-goals";
import { searchTransactions } from "./search-transactions";
import type { ToolContext } from "./shared";

export type { ToolContext } from "./shared";

/** Read-only tools. Writes (with confirmation) come in a later release. */
export function createReadTools(context: ToolContext) {
  return {
    list_accounts: listAccounts(context),
    list_categories: listCategories(context),
    search_transactions: searchTransactions(context),
    get_transaction_summary: getTransactionSummary(context),
    get_spending_by_category: getSpendingByCategory(context),
    get_cashflow: getCashflow(context),
    get_net_worth: getNetWorth(context),
    list_goals: listGoals(context),
    list_debts: listDebts(context),
  };
}

export type ReadTools = ReturnType<typeof createReadTools>;

export const READ_TOOL_NAMES = [
  "list_accounts",
  "list_categories",
  "search_transactions",
  "get_transaction_summary",
  "get_spending_by_category",
  "get_cashflow",
  "get_net_worth",
  "list_goals",
  "list_debts",
] as const satisfies ReadonlyArray<keyof ReadTools>;
