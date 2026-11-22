import type { Transaction } from "@mpf/finance-contract";

export interface RecentTransactionItem {
  id: string;
  date: string;
  description: string;
  category: string;
  /** Signed minor units: negative for expenses and outgoing transfers. */
  amountMinor: number;
  currency: string;
  type: Transaction["type"];
  account: string;
}

/** Rows for the recent-transactions card, each in its account's currency. */
export function buildRecentTransactions(
  transactions: Transaction[],
  accountNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
): RecentTransactionItem[] {
  return transactions.map((tx) => {
    const amount = tx.amount.amountMinor;
    const outgoing = tx.type === "expense" || (tx.type === "transfer" && tx.destinationAccountId !== undefined);
    return {
      id: tx.id,
      date: tx.date,
      description: tx.description || tx.payee || "Untitled",
      category:
        tx.type === "adjustment"
          ? "Adjustment"
          : tx.type === "transfer"
            ? "Transfer"
            : (categoryNames.get(tx.categoryId ?? "") ?? "Uncategorized"),
      amountMinor: outgoing ? -Math.abs(amount) : amount,
      currency: tx.amount.currency,
      type: tx.type,
      account: accountNames.get(tx.accountId) ?? "Unknown account",
    };
  });
}
