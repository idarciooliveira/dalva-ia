import type { Transaction } from "@mpf/finance-contract";
import { tool } from "ai";
import { z } from "zod";

import { clip, compact, dateInput, guarded, idInput, money, type ToolContext } from "./shared";

export const SEARCH_MAX_LIMIT = 20;
const DEFAULT_LIMIT = 10;

export const searchTransactions = (context: ToolContext) =>
  tool({
    description:
      "Search the user's transactions, newest first. Filter by date range, account, category, type or text. Returns at most 20 rows; `hasMore` says if there are more. Use for lists of transactions; use the report tools for totals.",
    inputSchema: z.object({
      dateFrom: dateInput.optional().describe("First day, YYYY-MM-DD, inclusive."),
      dateTo: dateInput.optional().describe("Last day, YYYY-MM-DD, inclusive."),
      accountId: idInput.optional().describe("Account id from list_accounts."),
      categoryId: idInput.optional().describe("Category id from list_categories."),
      type: z.enum(["income", "expense", "adjustment", "transfer"]).optional(),
      text: z.string().trim().min(1).max(100).optional().describe("Words in the description, note or payee."),
      limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Rows to return, default ${DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}.`),
    }),
    execute: (input) =>
      guarded(context, async () => {
        const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
        // Names make the answer readable without extra tool calls; best effort.
        const names = Promise.all([
          context.finance.accounts.list({ includeArchived: true }).catch(() => ({ items: [] })),
          context.finance.categories.list({ includeArchived: true }).catch(() => ({ items: [] })),
        ]);
        const { items, nextCursor } = await context.finance.transactions.search(
          compact({
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            accountId: input.accountId,
            categoryId: input.categoryId,
            type: input.type,
            q: input.text,
            limit,
          }),
        );
        const [accounts, categories] = await names;
        const accountName = new Map(accounts.items.map((a) => [a.id as string, a.name]));
        const categoryName = new Map(categories.items.map((c) => [c.id as string, c.name]));
        return {
          transactions: items.slice(0, limit).map((tx: Transaction) =>
            compact({
              id: tx.id,
              date: tx.date,
              type: tx.type,
              amount: money(tx.amount),
              account: accountName.get(tx.accountId) ?? tx.accountId,
              toAccount: tx.destinationAccountId ? (accountName.get(tx.destinationAccountId) ?? tx.destinationAccountId) : undefined,
              category: tx.categoryId ? (categoryName.get(tx.categoryId) ?? tx.categoryId) : undefined,
              description: clip(tx.description),
              payee: clip(tx.payee, 60),
            }),
          ),
          hasMore: nextCursor !== null || items.length > limit,
        };
      }),
  });
