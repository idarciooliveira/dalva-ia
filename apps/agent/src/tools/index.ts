import { addGoalContribution } from "./add-goal-contribution";
import { createTransaction } from "./create-transaction";
import { createTransfer } from "./create-transfer";
import { deleteTransaction } from "./delete-transaction";
import { deleteTransfer } from "./delete-transfer";
import { getCashflow } from "./get-cashflow";
import { getNetWorth } from "./get-net-worth";
import { getSpendingByCategory } from "./get-spending-by-category";
import { getTransactionSummary } from "./get-transaction-summary";
import { listAccounts } from "./list-accounts";
import { listCategories } from "./list-categories";
import { listDebts } from "./list-debts";
import { listGoals } from "./list-goals";
import type { WriteContext } from "./proposals";
import { recordDebtPayment } from "./record-debt-payment";
import { searchTransactions } from "./search-transactions";
import type { ToolContext } from "./shared";
import { updateTransaction } from "./update-transaction";

export type { ToolContext } from "./shared";
export type { WriteContext } from "./proposals";

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

/** Write tools only propose: each stores a pending action the user confirms with a button. */
export function createWriteTools(context: ToolContext, write: WriteContext) {
  return {
    create_transaction: createTransaction(context, write),
    update_transaction: updateTransaction(context, write),
    delete_transaction: deleteTransaction(context, write),
    create_transfer: createTransfer(context, write),
    delete_transfer: deleteTransfer(context, write),
    add_goal_contribution: addGoalContribution(context, write),
    record_debt_payment: recordDebtPayment(context, write),
  };
}

/** Read tools, plus the write tools when the chat may write (`write` given). */
export function createTools(context: ToolContext, write?: WriteContext) {
  return write ? { ...createReadTools(context), ...createWriteTools(context, write) } : createReadTools(context);
}

export type ReadTools = ReturnType<typeof createReadTools>;
export type WriteTools = ReturnType<typeof createWriteTools>;

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

export const WRITE_TOOL_NAMES = [
  "create_transaction",
  "update_transaction",
  "delete_transaction",
  "create_transfer",
  "delete_transfer",
  "add_goal_contribution",
  "record_debt_payment",
] as const satisfies ReadonlyArray<keyof WriteTools>;
