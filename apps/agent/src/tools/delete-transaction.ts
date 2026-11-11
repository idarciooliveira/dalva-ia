import { tool } from "ai";
import { z } from "zod";

import { fitSummary, labels } from "../core/summary";
import { describeTransaction, MANAGED_MESSAGES } from "./describe-transaction";
import { languageInput, lookups, propose, ProposalError, type WriteContext } from "./proposals";
import { call, idInput, type ToolContext } from "./shared";

export const deleteTransaction = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose deleting one income, expense or adjustment (find it with search_transactions first). Nothing is deleted until the user presses Confirm. For transfers use delete_transfer.",
    inputSchema: z.object({
      id: idInput.describe("Transaction id from search_transactions."),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        const look = lookups(context);
        const { transaction: tx, managedBy } = await context.finance.transactions.get({ id: input.id }, call(context));
        if (managedBy) throw new ProposalError("managed", MANAGED_MESSAGES[managedBy]);
        const words = labels(input.language);
        const parts = await describeTransaction(look, tx, context.today, input.language);
        return {
          operation: "transactions.delete",
          input: { id: input.id },
          // Amount and date always identify the row; the rest is cut first if names are long.
          summary: fitSummary(
            [`${words.delete} ${words[tx.type].toLowerCase()}`, parts.amount, parts.date],
            [parts.category, parts.account, parts.payee, parts.description],
          ),
        };
      }),
  });
