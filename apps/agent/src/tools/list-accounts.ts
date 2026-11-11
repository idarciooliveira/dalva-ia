import { tool } from "ai";
import { z } from "zod";

import { bounded, compact, guarded, includeArchivedInput, money, type ToolContext } from "./shared";

const MAX_ACCOUNTS = 50;

export const listAccounts = (context: ToolContext) =>
  tool({
    description:
      "List the user's accounts with their current balances (bank, savings, cash, credit cards, loans, e-wallets). Credit cards and loans are usually negative. Each balance is in the account's own currency.",
    inputSchema: z.object({ includeArchived: includeArchivedInput }),
    execute: ({ includeArchived }) =>
      guarded(context, async () => {
        const { items } = await context.finance.accounts.list({ includeArchived: includeArchived ?? false });
        const visible = includeArchived ? items : items.filter((account) => !account.archived);
        const { items: accounts, truncated } = bounded(visible, MAX_ACCOUNTS);
        return compact({
          accounts: accounts.map((account) =>
            compact({
              id: account.id,
              name: account.name,
              type: account.type,
              balance: money(account.balance),
              archived: account.archived || undefined,
            }),
          ),
          truncated: truncated || undefined,
        });
      }),
  });
