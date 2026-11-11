import { tool } from "ai";
import { z } from "zod";

import { formatAmount, formatDay, joinSummary, labels, quoted, shortText } from "../core/summary";
import { amountInput, checkCurrency, currencyInput, languageInput, lookups, optionalText, propose, ProposalError, toMinor, type WriteContext } from "./proposals";
import { dateInput, idInput, type ToolContext } from "./shared";

export const createTransfer = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose moving money between two of the user's accounts in the same currency. Nothing is saved until the user presses Confirm. Resolve both account ids with list_accounts first; ask if either is ambiguous.",
    inputSchema: z.object({
      amount: amountInput,
      currency: currencyInput,
      fromAccountId: idInput.describe("Source account id."),
      toAccountId: idInput.describe("Destination account id."),
      date: dateInput.optional().describe("YYYY-MM-DD. Defaults to today."),
      description: z.string().max(200).optional(),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        if (input.fromAccountId === input.toAccountId) throw new ProposalError("invalid_input", "Source and destination must be different accounts.");
        const look = lookups(context);
        const [from, to] = await Promise.all([look.activeAccount(input.fromAccountId), look.activeAccount(input.toAccountId)]);
        const currency = from.balance.currency;
        if (to.balance.currency !== currency) {
          throw new ProposalError(
            "invalid_input",
            `Transfers between currencies (${currency} → ${to.balance.currency}) aren't supported. Tell the user plainly.`,
          );
        }
        checkCurrency(input.currency, currency, "The source account");
        const amountMinor = toMinor(input.amount, currency);
        const date = input.date ?? context.today;
        const description = optionalText(input.description, 200);
        return {
          operation: "transfers.create",
          input: {
            amount: { amountMinor, currency },
            fromAccountId: input.fromAccountId,
            toAccountId: input.toAccountId,
            date,
            ...(description ? { description } : {}),
          },
          summary: joinSummary([
            labels(input.language).transfer,
            formatAmount(amountMinor, currency, input.language),
            `${shortText(from.name)} → ${shortText(to.name)}`,
            formatDay(date, context.today, input.language),
            description && quoted(description),
          ]),
        };
      }),
  });
