import { tool } from "ai";
import { z } from "zod";

import { fitSummary, formatAmount, formatDay, labels, quoted, shortText } from "../core/summary";
import { MANAGED_MESSAGES } from "./describe-transaction";
import { languageInput, lookups, propose, ProposalError, type WriteContext } from "./proposals";
import { call, idInput, type ToolContext } from "./shared";

export const deleteTransfer = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose deleting a transfer (both legs). Pass the id of either leg from search_transactions (type transfer). Nothing is deleted until the user presses Confirm.",
    inputSchema: z.object({
      id: idInput.describe("Id of either leg of the transfer."),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        const look = lookups(context);
        const { transaction: tx, managedBy } = await context.finance.transactions.get({ id: input.id }, call(context));
        if (managedBy === "goal_contribution" || managedBy === "debt_payment") throw new ProposalError("managed", MANAGED_MESSAGES[managedBy]);
        if (tx.type !== "transfer") throw new ProposalError("invalid_input", "That is not a transfer. Use delete_transaction for income and expenses.");
        // The outgoing leg names the destination; from the incoming leg, read its pair for the source.
        let fromId: string | undefined = tx.destinationAccountId ? tx.accountId : undefined;
        let toId: string | undefined = tx.destinationAccountId ?? tx.accountId;
        if (!tx.destinationAccountId && tx.linkedTransactionId) {
          fromId = await context.finance.transactions.get({ id: tx.linkedTransactionId }, call(context)).then(
            (r) => r.transaction.accountId,
            () => undefined,
          );
          toId = tx.accountId;
        }
        const name = (id: string | undefined) =>
          id
            ? look.account(id).then(
                (a) => shortText(a.name),
                () => "?",
              )
            : Promise.resolve("?");
        const [from, to] = await Promise.all([name(fromId), name(toId)]);
        const words = labels(input.language);
        return {
          operation: "transfers.delete",
          input: { id: input.id },
          summary: fitSummary(
            [
              `${words.delete} ${words.transfer.toLowerCase()}`,
              formatAmount(tx.amount.amountMinor, tx.amount.currency, input.language),
              `${from} → ${to}`,
              formatDay(tx.date, context.today, input.language),
            ],
            [tx.description ? quoted(shortText(tx.description, 60)) : undefined],
          ),
        };
      }),
  });
