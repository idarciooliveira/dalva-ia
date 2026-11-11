import { formatMinorAmount } from "@mpf/finance-contract";

/**
 * Confirmation text for a proposed change, built by code from the validated
 * input (never by the model), so what the user confirms is what runs.
 * Portuguese or English, one line, parts joined by " · ".
 */

export type Language = "pt" | "en";

const LABELS = {
  pt: {
    expense: "Despesa",
    income: "Receita",
    adjustment: "Ajuste",
    transfer: "Transferência",
    edit: "Editar",
    delete: "Apagar",
    goal: "Contribuição para meta",
    debt: "Pagamento de dívida",
    from: "de",
    interest: "juros",
    today: "hoje",
    yesterday: "ontem",
    tomorrow: "amanhã",
    fields: { type: "tipo", amount: "valor", account: "conta", category: "categoria", date: "data", description: "descrição", payee: "beneficiário" },
  },
  en: {
    expense: "Expense",
    income: "Income",
    adjustment: "Adjustment",
    transfer: "Transfer",
    edit: "Edit",
    delete: "Delete",
    goal: "Goal contribution",
    debt: "Debt payment",
    from: "from",
    interest: "interest",
    today: "today",
    yesterday: "yesterday",
    tomorrow: "tomorrow",
    fields: { type: "type", amount: "amount", account: "account", category: "category", date: "date", description: "description", payee: "payee" },
  },
} as const;

export type ChangeField = keyof (typeof LABELS)["en"]["fields"];
export type TxKind = "expense" | "income" | "adjustment" | "transfer";

export const labels = (language: Language) => LABELS[language];

/** First words of every summary, per language: tells the language of a stored summary. */
const PT_STARTS = [LABELS.pt.expense, LABELS.pt.income, LABELS.pt.adjustment, LABELS.pt.transfer, LABELS.pt.edit, LABELS.pt.delete, LABELS.pt.goal, LABELS.pt.debt];

/** Language a summary was written in (summaries always start with a fixed label). */
export function summaryLanguage(summary: string): Language {
  return PT_STARTS.some((start) => summary.startsWith(start)) ? "pt" : "en";
}

/** `500000` AOA -> `5 000,00 AOA` (pt) / `5,000.00 AOA` (en). */
export function formatAmount(amountMinor: number, currency: string, language: Language): string {
  const plain = formatMinorAmount(amountMinor, currency);
  const negative = plain.startsWith("-");
  const [whole = "0", fraction] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, language === "pt" ? " " : ",");
  const decimal = language === "pt" ? "," : ".";
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? `${decimal}${fraction}` : ""} ${currency}`;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;

/** `today` / `yesterday` / `tomorrow`, else `10/11/2026` (pt) or `Nov 10, 2026` (en). */
export function formatDay(date: string, today: string, language: Language): string {
  const words = LABELS[language];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
    const diff = dayNumber(date) - dayNumber(today);
    if (diff === 0) return words.today;
    if (diff === -1) return words.yesterday;
    if (diff === 1) return words.tomorrow;
  }
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return date;
  return language === "pt" ? `${day}/${month}/${year}` : `${MONTHS_EN[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

/** User-entered names and texts, kept short and on one line. */
export function shortText(text: string, max = 40): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Free text that will be written: shown in full (one line), never cut. */
export const quoted = (text: string) => `“${text.replace(/\s+/g, " ").trim()}”`;

export const SUMMARY_MAX = 500;

/** The summary can't show everything that would be written. */
export class SummaryTooLongError extends Error {}

type Part = string | undefined | false;
const present = (parts: Part[]) => parts.filter((part): part is string => typeof part === "string" && part.length > 0);

/**
 * Summary within the backend's 500 characters. `written` parts (what the
 * change writes) are always shown in full; `context` parts (what identifies
 * the existing row) are cut shorter, then dropped from the end, to make room.
 * When `written` alone doesn't fit, throws `SummaryTooLongError`: the caller
 * refuses the proposal rather than hide part of it.
 */
export function fitSummary(written: Part[], context: Part[] = []): string {
  const required = present(written);
  let extra = present(context);
  const join = () => [...required, ...extra].join(" · ");
  if (join().length <= SUMMARY_MAX) return join();
  extra = extra.map((part) => shortText(part, 20));
  while (extra.length > 0 && join().length > SUMMARY_MAX) extra = extra.slice(0, -1);
  if (join().length > SUMMARY_MAX) throw new SummaryTooLongError();
  return join();
}

/** Every part is written by the change: none may be cut. */
export const joinSummary = (parts: Part[]) => fitSummary(parts);

/** `Alimentação › Restaurantes`. */
export const categoryLabel = (category?: string, subcategory?: string) =>
  category ? (subcategory ? `${category} › ${subcategory}` : category) : undefined;
