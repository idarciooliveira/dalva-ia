import { tool } from "ai";
import { z } from "zod";

import { formatAmount, formatDay, joinSummary, labels, quoted, shortText } from "../core/summary";
import { amountInput, checkCurrency, currencyInput, languageInput, lookups, optionalText, propose, ProposalError, toMinor, type WriteContext } from "./proposals";
import { call, dateInput, idInput, type ToolContext } from "./shared";

export const addGoalContribution = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose adding money to a savings goal (list_goals for the id). Goals linked to an account need the account the money comes from (list_accounts). Nothing is saved until the user presses Confirm.",
    inputSchema: z.object({
      goalId: idInput.describe("Goal id from list_goals."),
      amount: amountInput,
      currency: currencyInput,
      fromAccountId: idInput.optional().describe("Source account id; required when the goal is linked to an account."),
      date: dateInput.optional().describe("YYYY-MM-DD. Defaults to today."),
      note: z.string().max(200).optional(),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        const look = lookups(context);
        const { goal } = await context.finance.goals.get({ id: input.goalId }, call(context));
        if (goal.archived) throw new ProposalError("invalid_input", "That goal is archived.");
        const currency = goal.targetAmount.currency;
        checkCurrency(input.currency, currency, "This goal");
        let fromName: string | undefined;
        if (goal.linkedAccountId) {
          if (!input.fromAccountId) {
            throw new ProposalError("invalid_input", "This goal is linked to an account: ask the user which account the money comes from, then pass fromAccountId.");
          }
          if (input.fromAccountId === goal.linkedAccountId) {
            throw new ProposalError("invalid_input", "The money must come from another account than the goal's own account.");
          }
          const from = await look.activeAccount(input.fromAccountId);
          if (from.balance.currency !== currency) {
            throw new ProposalError("invalid_input", `The account is in ${from.balance.currency} but the goal is in ${currency}; there is no conversion.`);
          }
          fromName = shortText(from.name);
        } else if (input.fromAccountId) {
          throw new ProposalError("invalid_input", "This goal isn't linked to an account, so a contribution doesn't move money between accounts. Leave fromAccountId out.");
        }
        const amountMinor = toMinor(input.amount, currency);
        const date = input.date ?? context.today;
        const note = optionalText(input.note, 200);
        const words = labels(input.language);
        return {
          operation: "goalContributions.add",
          input: {
            goalId: input.goalId,
            amount: { amountMinor, currency },
            date,
            ...(note ? { note } : {}),
            ...(goal.linkedAccountId ? { fromAccountId: input.fromAccountId } : {}),
          },
          summary: joinSummary([
            words.goal,
            formatAmount(amountMinor, currency, input.language),
            shortText(goal.name),
            fromName && `${words.from} ${fromName}`,
            formatDay(date, context.today, input.language),
            note && quoted(note),
          ]),
        };
      }),
  });
