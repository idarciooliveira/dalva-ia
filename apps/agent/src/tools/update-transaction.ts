import { tool } from "ai";
import { z } from "zod";

import { categoryLabel, fitSummary, formatAmount, formatDay, labels, quoted, shortText, SummaryTooLongError, type ChangeField } from "../core/summary";
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

        const current = await describeTransaction(look, tx, context.today, input.language);
        const changes: Record<string, unknown> = {};
        /** Changed field, its current value (context, may be shortened or dropped) and its new value (always shown in full). */
        const shown: Array<{ field: ChangeField; from?: string; to: string }> = [];
        const words = labels(input.language);
        if (typeChanges) {
          changes.type = type;
          shown.push({ field: "type", from: words[tx.type].toLowerCase(), to: words[type].toLowerCase() });
        }

        const targetAccount = await look.activeAccount(input.accountId ?? tx.accountId);
        const currency = targetAccount.balance.currency;
        if (input.amount !== undefined) {
          checkCurrency(input.currency, currency);
          const amountMinor = toMinor(input.amount, currency);
          changes.amount = { amountMinor, currency };
          shown.push({ field: "amount", from: current.amount, to: formatAmount(amountMinor, currency, input.language) });
        } else if (currency !== tx.amount.currency) {
          throw new ProposalError("invalid_input", `The new account is in ${currency}: moving the row there needs the amount in ${currency} too. Ask the user for it.`);
        }
        if (input.accountId !== undefined && input.accountId !== tx.accountId) {
          changes.accountId = input.accountId;
          shown.push({ field: "account", from: current.account, to: shortText(targetAccount.name) });
        }
        if (input.categoryId !== undefined || input.subcategoryId !== undefined) {
          const classification = await look.classification(type, input.categoryId, input.subcategoryId);
          changes.categoryId = classification.categoryId;
          if (classification.subcategoryId) changes.subcategoryId = classification.subcategoryId;
          shown.push({ field: "category", from: current.category, to: categoryLabel(classification.names?.category, classification.names?.subcategory)! });
        }
        if (input.date !== undefined && input.date !== tx.date) {
          changes.date = input.date;
          shown.push({ field: "date", from: current.date, to: formatDay(input.date, context.today, input.language) });
        }
        const description = optionalText(input.description, 200);
        if (description !== undefined && description !== tx.description) {
          changes.description = description;
          shown.push({ field: "description", from: current.description, to: quoted(description) });
        }
        const payee = optionalText(input.payee, 100);
        if (payee !== undefined && payee !== tx.payee) {
          changes.payee = payee;
          shown.push({ field: "payee", from: current.payee, to: payee });
        }
        if (shown.length === 0) throw new ProposalError("invalid_input", "Nothing to change: pass at least one field with a new value.");

        // Unchanged parts of the row, after the changes.
        const changed = new Set(shown.map((change) => change.field));
        const rest = [
          !changed.has("amount") && current.amount,
          !changed.has("category") && current.category,
          !changed.has("account") && current.account,
          !changed.has("date") && current.date,
          !changed.has("payee") && current.payee,
          !changed.has("description") && current.description,
        ];
        const head = `${words.edit} ${words[tx.type].toLowerCase()}`;
        // Changes first, every new value in full. To fit, the old values are cut, then dropped, never the new ones.
        const render = (from: (value: string) => string | undefined) =>
          shown.map(({ field, from: old, to }) => {
            const before = old === undefined ? undefined : from(old);
            return `${words.fields[field]}: ${before ? `${before} → ` : ""}${to}`;
          });
        const levels = [(v: string) => v, (v: string) => shortText(v, 20), () => undefined];
        let summary: string | undefined;
        for (const [index, level] of levels.entries()) {
          try {
            summary = fitSummary([head, ...render(level)], rest);
            break;
          } catch (error) {
            if (!(error instanceof SummaryTooLongError) || index === levels.length - 1) throw error;
          }
        }
        return {
          operation: "transactions.update",
          input: { id: input.id, ...changes },
          summary: summary!,
        };
      }),
  });
