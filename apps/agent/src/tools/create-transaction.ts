import { tool } from "ai";
import { z } from "zod";

import { categoryLabel, formatAmount, formatDay, joinSummary, labels, quoted, shortText } from "../core/summary";
import { amountInput, checkCurrency, currencyInput, languageInput, lookups, optionalText, propose, toMinor, type WriteContext } from "./proposals";
import { dateInput, idInput, type ToolContext } from "./shared";

export const createTransaction = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose a new income or expense. Nothing is saved until the user presses Confirm. Resolve the account (list_accounts) and category (list_categories) ids first; if the account is ambiguous, ask instead of calling this.",
    inputSchema: z.object({
      type: z.enum(["income", "expense"]),
      amount: amountInput,
      currency: currencyInput,
      accountId: idInput.describe("Account id from list_accounts."),
      categoryId: idInput.optional().describe("Category id from list_categories, of the same type."),
      subcategoryId: idInput.optional().describe("Subcategory id from list_categories."),
      date: dateInput.optional().describe("YYYY-MM-DD. Defaults to today."),
      description: z.string().max(200).optional().describe("Short description, e.g. what was bought."),
      payee: z.string().max(100).optional().describe("Who was paid or who paid."),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        const look = lookups(context);
        const account = await look.activeAccount(input.accountId);
        const currency = account.balance.currency;
        checkCurrency(input.currency, currency);
        const amountMinor = toMinor(input.amount, currency);
        const classification = await look.classification(input.type, input.categoryId, input.subcategoryId);
        const date = input.date ?? context.today;
        const description = optionalText(input.description, 200);
        const payee = optionalText(input.payee, 100);
        const words = labels(input.language);
        return {
          operation: "transactions.create",
          input: {
            type: input.type,
            amount: { amountMinor, currency },
            accountId: input.accountId,
            ...(classification.categoryId ? { categoryId: classification.categoryId } : {}),
            ...(classification.subcategoryId ? { subcategoryId: classification.subcategoryId } : {}),
            date,
            ...(description ? { description } : {}),
            ...(payee ? { payee } : {}),
          },
          summary: joinSummary([
            words[input.type],
            formatAmount(amountMinor, currency, input.language),
            categoryLabel(classification.names?.category, classification.names?.subcategory),
            shortText(account.name),
            formatDay(date, context.today, input.language),
            payee && shortText(payee),
            description && quoted(description),
          ]),
        };
      }),
  });
