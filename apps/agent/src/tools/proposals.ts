import {
  currencyExponent,
  MoneyError,
  parseDecimalAmount,
  routes,
  type Account,
  type AgentActionOperation,
  type AgentPendingAction,
  type Category,
  type FinanceClient,
  type RouteDef,
  type Subcategory,
} from "@mpf/finance-contract";
import { z } from "zod";

import { shortText, SummaryTooLongError, type Language } from "../core/summary";
import { call, toToolError, type ToolContext, type ToolError } from "./shared";

/**
 * Write tools never write. They build a validated request plus a summary and
 * store it as a pending action; the user's Confirm button runs it later (see
 * `core/actions.ts`). At most one proposal per turn.
 */

export interface ProposalsOptions {
  finance: FinanceClient;
  /** Inbound event of the turn: with the proposal index it forms the action's `clientKey`. */
  eventId: string;
  /** Session the action belongs to (the chat's current one). */
  sessionId: (signal?: AbortSignal) => Promise<string>;
}

/** The turn's single proposal slot. */
export class Proposals {
  /** The action this turn proposed (or found, on a replay). */
  current: { action: AgentPendingAction } | null = null;
  private busy = false;

  constructor(private readonly options: ProposalsOptions) {}

  /** Synchronous, so two tool calls running at once can't both take it. */
  claim(): boolean {
    if (this.busy || this.current) return false;
    this.busy = true;
    return true;
  }

  release(): void {
    this.busy = false;
  }

  /**
   * One proposal per turn, so the key is always `<eventId>:0`: a replay of the
   * event (boot recovery) gets the same action back instead of a second one.
   */
  async create(proposal: Proposal, signal?: AbortSignal): Promise<AgentPendingAction> {
    const sessionId = await this.options.sessionId(signal);
    const { action } = await this.options.finance.agentPendingActions.create(
      {
        sessionId,
        operation: proposal.operation,
        input: proposal.input as Record<string, never>,
        summary: proposal.summary,
        clientKey: `${this.options.eventId}:0`,
      },
      { signal },
    );
    this.current = { action };
    return action;
  }
}

export interface WriteContext {
  proposals: Proposals;
}

export interface Proposal {
  operation: AgentActionOperation;
  /** Flat request of the operation, as the finance client takes it. */
  input: Record<string, unknown>;
  summary: string;
}

/** A proposal the model must fix or ask about. Messages are fixed text, never echoed input. */
export class ProposalError extends Error {
  constructor(
    readonly code: "invalid_input" | "managed" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export type ProposalResult =
  | { status: "awaiting_confirmation"; summary: string }
  | { status: `already_${string}`; summary: string; message: string }
  | ToolError;

const ONE_AT_A_TIME: ToolError = {
  error: "one_at_a_time",
  message:
    "Only one change can be proposed per message. Propose the next one after the user answers the current proposal (if your other proposal in this message failed, fix it and try again).",
};

const routeOf = (operation: AgentActionOperation): RouteDef => {
  const [group, op] = operation.split(".") as [string, string];
  return (routes as unknown as Record<string, Record<string, RouteDef>>)[group]![op]!;
};

/** Field paths and the schema's own messages only: no input values. */
function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/**
 * Run a write tool: take the turn's slot, build the request, check it against
 * the operation's contract schema, then store it as a pending action. The slot
 * is given back when nothing was stored, so the model can fix its input.
 */
export async function propose(context: ToolContext, write: WriteContext, build: () => Promise<Proposal>): Promise<ProposalResult> {
  const { proposals } = write;
  if (!proposals.claim()) return ONE_AT_A_TIME;
  try {
    const proposal = await build();
    const parsed = routeOf(proposal.operation).request.safeParse(proposal.input);
    if (!parsed.success) return { error: "invalid_input", message: `Invalid request: ${issuesText(parsed.error)}` };
    const action = await proposals.create({ ...proposal, input: parsed.data as Record<string, unknown> }, context.signal);
    if (action.status === "pending") return { status: "awaiting_confirmation", summary: action.summary };
    return {
      status: `already_${action.status}`,
      summary: action.summary,
      message: `This request was already handled (${action.status}). Tell the user its current state; don't propose it again.`,
    };
  } catch (error) {
    if (error instanceof ProposalError) return { error: error.code, message: error.message };
    if (error instanceof SummaryTooLongError) {
      return {
        error: "too_long",
        message: "The confirmation can't show all of these changes at once. Ask the user to change fewer things at once (for example, the amount and date now, the rest next).",
      };
    }
    return toToolError(error, context);
  } finally {
    if (!proposals.current) proposals.release();
  }
}

/* -------------------------------------------------------------------------- */
/*  Inputs and lookups shared by the write tools                              */
/* -------------------------------------------------------------------------- */

export const languageInput = z
  .enum(["pt", "en"])
  .describe("Language of the user's message (pt or en). The confirmation text is written in it.");

export const amountInput = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .describe('Positive amount as a plain decimal string with a dot: "5000", "12.50". No thousands separators, no currency symbol. "300 mil" is "300000".');

export const currencyInput = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .optional()
  .describe("ISO code of the currency the user named, if any (kz, kwanza = AOA). Must match the account's currency.");

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** Decimals DALVA stores for every currency (amounts are kept as value x 100); the backend refuses finer ones. */
const STORED_DECIMALS = 2;

/** Decimal string -> positive minor units. Rejects extra decimals instead of rounding: the user confirms the exact amount. */
export function toMinor(amount: string, currency: string, field = "amount", allowZero = false): number {
  const value = amount.trim();
  if (!DECIMAL.test(value)) {
    throw new ProposalError("invalid_input", `${field} must be a plain decimal like 5000 or 12.50 (dot for decimals, no thousands separators or signs).`);
  }
  const exponent = currencyExponent(currency);
  // Trailing zeros change nothing ("1500.00" JPY is 1500); other extra decimals would need rounding.
  const [whole, fraction = ""] = value.split(".");
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > exponent) {
    throw new ProposalError("invalid_input", `${currency} amounts have at most ${exponent} decimal places (${field}).`);
  }
  let minor: number;
  try {
    minor = parseDecimalAmount(significant ? `${whole}.${significant}` : whole!, currency);
  } catch (error) {
    if (error instanceof MoneyError) throw new ProposalError("invalid_input", `${field} is too large.`);
    throw error;
  }
  if (minor === 0 && !allowZero) throw new ProposalError("invalid_input", `${field} must be greater than zero.`);
  // DALVA stores every currency with 2 decimals (value x 100): a finer amount would be saved rounded.
  if (exponent > STORED_DECIMALS && minor % 10 ** (exponent - STORED_DECIMALS) !== 0) {
    throw new ProposalError(
      "invalid_input",
      `${currency} only supports ${STORED_DECIMALS} decimal places in DALVA for now (${field}). Tell the user and ask for the amount rounded to ${STORED_DECIMALS} decimals.`,
    );
  }
  return minor;
}

/** The currency the user named must be the one the amount will be stored in: there is no conversion. */
export function checkCurrency(named: string | undefined, actual: string, what = "This account"): void {
  if (named && named.toUpperCase() !== actual) {
    throw new ProposalError(
      "invalid_input",
      `${what} is in ${actual}, not ${named.toUpperCase()}. Amounts are never converted between currencies; ask the user which account or amount they mean.`,
    );
  }
}

/** Per-tool memo of reads, so one proposal makes each list call once. */
export function lookups(context: ToolContext) {
  const { finance } = context;
  let categories: Promise<Category[]> | undefined;
  let subcategories: Promise<Subcategory[]> | undefined;
  const accounts = new Map<string, Promise<Account>>();
  return {
    account(id: string): Promise<Account> {
      if (!accounts.has(id)) accounts.set(id, finance.accounts.get({ id }, call(context)).then((r) => r.account));
      return accounts.get(id)!;
    },
    /** An account the user can still write to. */
    async activeAccount(id: string): Promise<Account> {
      const account = await this.account(id);
      if (account.archived) throw new ProposalError("invalid_input", `The account "${shortText(account.name)}" is archived. Ask the user which active account to use.`);
      return account;
    },
    categories(): Promise<Category[]> {
      categories ??= finance.categories.list({ includeArchived: true }, call(context)).then((r) => r.items);
      return categories;
    },
    subcategories(): Promise<Subcategory[]> {
      subcategories ??= finance.subcategories.list({ includeArchived: true }, call(context)).then((r) => r.items);
      return subcategories;
    },
    /** Names for a category and subcategory (any state), for summaries. */
    async classificationNames(categoryId?: string, subcategoryId?: string): Promise<{ category?: string; subcategory?: string }> {
      if (!categoryId && !subcategoryId) return {};
      const [cats, subs] = await Promise.all([this.categories(), subcategoryId ? this.subcategories() : Promise.resolve([])]);
      const category = cats.find((c) => c.id === categoryId);
      const subcategory = subs.find((s) => s.id === subcategoryId);
      return {
        ...(category ? { category: shortText(category.name) } : {}),
        ...(subcategory ? { subcategory: shortText(subcategory.name) } : {}),
      };
    },
    /**
     * Category/subcategory for a new or edited income/expense row: they must
     * exist, be active, match the type, and the subcategory must sit under the
     * category. A subcategory alone implies its category.
     */
    async classification(type: "income" | "expense", categoryId?: string, subcategoryId?: string): Promise<Classification> {
      if (!categoryId && !subcategoryId) return {};
      const [cats, subs] = await Promise.all([this.categories(), subcategoryId ? this.subcategories() : Promise.resolve([])]);
      const subcategory = subcategoryId ? subs.find((s) => s.id === subcategoryId && !s.archived) : undefined;
      if (subcategoryId && !subcategory) throw new ProposalError("invalid_input", "Unknown or archived subcategory. Call list_categories for valid ids.");
      const resolvedCategoryId = categoryId ?? subcategory!.categoryId;
      const category = cats.find((c) => c.id === resolvedCategoryId && !c.archived);
      if (!category) throw new ProposalError("invalid_input", "Unknown or archived category. Call list_categories for valid ids.");
      if (category.type !== type) {
        throw new ProposalError("invalid_input", `That is an ${category.type} category; this is an ${type}. Pick an ${type} category from list_categories.`);
      }
      if (subcategory && subcategory.categoryId !== category.id) {
        throw new ProposalError("invalid_input", "That subcategory belongs to another category. Call list_categories for valid pairs.");
      }
      return {
        categoryId: category.id as string,
        ...(subcategory ? { subcategoryId: subcategory.id as string } : {}),
        names: { category: shortText(category.name), ...(subcategory ? { subcategory: shortText(subcategory.name) } : {}) },
      };
    },
  };
}

export type Lookups = ReturnType<typeof lookups>;

export interface Classification {
  categoryId?: string;
  subcategoryId?: string;
  names?: { category: string; subcategory?: string };
}

/** Optional free text from the model: one line, trimmed, bounded; empty means absent. */
export function optionalText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const line = value.replace(/\s+/g, " ").trim().slice(0, max);
  return line || undefined;
}

export type { Language };
