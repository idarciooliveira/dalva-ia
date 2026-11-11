import { tool } from "ai";
import { z } from "zod";

import { formatAmount, formatDay, joinSummary, labels, quoted, shortText } from "../core/summary";
import { amountInput, checkCurrency, currencyInput, languageInput, lookups, optionalText, propose, ProposalError, toMinor, type WriteContext } from "./proposals";
import { call, dateInput, idInput, type ToolContext } from "./shared";

export const recordDebtPayment = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose recording a payment on a debt (list_debts for the id) paid from one of the user's accounts (list_accounts). Nothing is saved until the user presses Confirm.",
    inputSchema: z.object({
      debtId: idInput.describe("Debt id from list_debts."),
      amount: amountInput.describe("Total paid, interest included."),
      interest: amountInput.optional().describe("Part of the amount that is interest, if the user said so."),
      currency: currencyInput,
      fromAccountId: idInput.describe("Account the payment comes from."),
      date: dateInput.optional().describe("YYYY-MM-DD. Defaults to today."),
      note: z.string().max(200).optional(),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        const look = lookups(context);
        const { debt } = await context.finance.debts.get({ id: input.debtId }, call(context));
        if (debt.archived) throw new ProposalError("invalid_input", "That debt is archived.");
        const currency = debt.currentBalance.currency;
        checkCurrency(input.currency, currency, "This debt");
        const from = await look.activeAccount(input.fromAccountId);
        if (from.balance.currency !== currency) {
          throw new ProposalError("invalid_input", `The account is in ${from.balance.currency} but the debt is in ${currency}; there is no conversion.`);
        }
        const amountMinor = toMinor(input.amount, currency);
        const interestMinor = input.interest === undefined ? 0 : toMinor(input.interest, currency, "interest", true);
        if (interestMinor > amountMinor) throw new ProposalError("invalid_input", "The interest can't be more than the payment.");
        const date = input.date ?? context.today;
        const note = optionalText(input.note, 200);
        const words = labels(input.language);
        return {
          operation: "debtPayments.record",
          input: {
            debtId: input.debtId,
            amount: { amountMinor, currency },
            ...(interestMinor > 0
              ? { principalAmount: { amountMinor: amountMinor - interestMinor, currency }, interestAmount: { amountMinor: interestMinor, currency } }
              : {}),
            date,
            ...(note ? { note } : {}),
            fromAccountId: input.fromAccountId,
          },
          summary: joinSummary([
            words.debt,
            formatAmount(amountMinor, currency, input.language),
            shortText(debt.name),
            `${words.from} ${shortText(from.name)}`,
            formatDay(date, context.today, input.language),
            interestMinor > 0 && `${words.interest} ${formatAmount(interestMinor, currency, input.language)}`,
            note && quoted(note),
          ]),
        };
      }),
  });
