import type { Transaction } from "@mpf/finance-contract";

/** Expenses and the outgoing leg of a transfer (it carries the destination) take money out. */
export function isOutgoing(tx: Pick<Transaction, "type" | "destinationAccountId">): boolean {
  return tx.type === "expense" || (tx.type === "transfer" && tx.destinationAccountId !== undefined);
}

export function transactionTitle(tx: Pick<Transaction, "description" | "payee">): string {
  return tx.description || tx.payee || "Untitled";
}

/** id → name, for labelling rows with account and category names. */
export function namesById(items: ReadonlyArray<{ id: string; name: string }> | undefined): Map<string, string> {
  return new Map((items ?? []).map((item) => [item.id, item.name]));
}

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
    return {
      id: tx.id,
      date: tx.date,
      description: transactionTitle(tx),
      category:
        tx.type === "adjustment"
          ? "Adjustment"
          : tx.type === "transfer"
            ? "Transfer"
            : (categoryNames.get(tx.categoryId ?? "") ?? "Uncategorized"),
      amountMinor: isOutgoing(tx) ? -Math.abs(amount) : amount,
      currency: tx.amount.currency,
      type: tx.type,
      account: accountNames.get(tx.accountId) ?? "Unknown account",
    };
  });
}
