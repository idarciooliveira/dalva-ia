import { tool } from "ai";
import { z } from "zod";

import { categoryLabel, formatAmount, formatDay, joinSummary, labels, shortText, type ChangeField } from "../core/summary";
import { describeTransaction, MANAGED_MESSAGES } from "./describe-transaction";
import { amountInput, checkCurrency, currencyInput, languageInput, lookups, optionalText, propose, ProposalError, toMinor, type WriteContext } from "./proposals";
import { call, dateInput, idInput, type ToolContext } from "./shared";

export const updateTransaction = (context: ToolContext, write: WriteContext) =>
  tool({
    description:
      "Propose a change to an existing income or expense (find it with search_transactions first). Pass only the fields that change. Nothing is saved until the user presses Confirm.",
    inputSchema: z.object({
      id: idInput.describe("Transaction id from search_transactions."),
      type: z.enum(["income", "expense"]).optional().describe("Only to switch between income and expense; then also pass a category of the new type."),
      amount: amountInput.optional(),
      currency: currencyInput,
      accountId: idInput.optional().describe("New account id from list_accounts."),
      categoryId: idInput.optional(),
      subcategoryId: idInput.optional(),
      date: dateInput.optional().describe("New date, YYYY-MM-DD."),
      description: z.string().max(200).optional(),
      payee: z.string().max(100).optional(),
      language: languageInput,
    }),
    execute: (input) =>
      propose(context, write, async () => {
        const look = lookups(context);
        const { transaction: tx, managedBy } = await context.finance.transactions.get({ id: input.id }, call(context));
        if (managedBy) throw new ProposalError("managed", MANAGED_MESSAGES[managedBy]);
        if (tx.type !== "income" && tx.type !== "expense") {
          throw new ProposalError("managed", "Only income and expenses can be edited here; balance adjustments are changed in the DALVA app.");
        }
        const type = input.type ?? tx.type;
        const typeChanges = type !== tx.type;
        if (typeChanges && !input.categoryId && !input.subcategoryId && tx.categoryId) {
          throw new ProposalError("invalid_input", `Switching to ${type} needs a ${type} category too. Ask the user which category.`);
        }

        const changes: Record<string, unknown> = {};
        const shown: Array<[ChangeField, string]> = [];
        const words = labels(input.language);
        if (typeChanges) {
          changes.type = type;
          shown.push(["type", words[type].toLowerCase()]);
        }

        const targetAccount = await look.activeAccount(input.accountId ?? tx.accountId);
        const currency = targetAccount.balance.currency;
        if (input.amount !== undefined) {
          checkCurrency(input.currency, currency);
          const amountMinor = toMinor(input.amount, currency);
          changes.amount = { amountMinor, currency };
          shown.push(["amount", formatAmount(amountMinor, currency, input.language)]);
        } else if (currency !== tx.amount.currency) {
          throw new ProposalError("invalid_input", `The new account is in ${currency}: moving the row there needs the amount in ${currency} too. Ask the user for it.`);
        }
        if (input.accountId !== undefined && input.accountId !== tx.accountId) {
          changes.accountId = input.accountId;
          shown.push(["account", shortText(targetAccount.name)]);
        }
        if (input.categoryId !== undefined || input.subcategoryId !== undefined) {
          const classification = await look.classification(type, input.categoryId, input.subcategoryId);
          changes.categoryId = classification.categoryId;
          if (classification.subcategoryId) changes.subcategoryId = classification.subcategoryId;
          shown.push(["category", categoryLabel(classification.names?.category, classification.names?.subcategory)!]);
        }
        if (input.date !== undefined && input.date !== tx.date) {
          changes.date = input.date;
          shown.push(["date", formatDay(input.date, context.today, input.language)]);
        }
        const description = optionalText(input.description, 200);
        if (description !== undefined && description !== tx.description) {
          changes.description = description;
          shown.push(["description", `“${shortText(description, 60)}”`]);
        }
        const payee = optionalText(input.payee, 100);
        if (payee !== undefined && payee !== tx.payee) {
          changes.payee = payee;
          shown.push(["payee", shortText(payee)]);
        }
        if (shown.length === 0) throw new ProposalError("invalid_input", "Nothing to change: pass at least one field with a new value.");

        const current = await describeTransaction(look, tx, context.today, input.language);
        const change = shown.map(([field, value]) => `${words.fields[field]}: ${value}`).join(", ");
        return {
          operation: "transactions.update",
          input: { id: input.id, ...changes },
          summary: joinSummary([`${words.edit} ${words[tx.type].toLowerCase()}`, ...current.slice(0, -1), `${current.at(-1) ?? ""} → ${change}`.trim()]),
        };
      }),
  });
