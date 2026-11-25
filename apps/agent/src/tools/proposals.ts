import { currencyExponent, MoneyError, parseDecimalAmount } from "@mpf/shared";
import { z } from "zod";

import {
  type Account,
  type AgentActionOperation,
  type AgentPendingAction,
  type Category,
  type FinanceClient,
  isFinanceError,
  type Subcategory,
} from "../core/finance";
import { shortText, SummaryTooLongError } from "../core/summary";
import { call, toToolError, type ToolContext, type ToolError } from "./shared";

/**
 * Write tools never write. Each builds a validated request plus a summary and
 * queues it for the turn; when the turn ends, everything it queued is stored
 * as one pending action (a `batch` when there are several), so one Confirm
 * button runs every change the user reported in the message (see `core/actions.ts`).
 */

/** Changes one message can queue (the API's batch limit). */
export const MAX_PROPOSALS = 10;

/** The backend's limit for the confirm text. */
const BATCH_SUMMARY_MAX = 4000;

export interface ProposalsOptions {
  finance: FinanceClient;
  /** Inbound event of the turn: the action's `clientKey` is `<eventId>:0`. */
  eventId: string;
  /** Session the action belongs to (the chat's current one). */
  sessionId: (signal?: AbortSignal) => Promise<string>;
}

/** `1. Despesa · …` per line: the confirm text of a batch. */
export const batchSummary = (summaries: string[]) => summaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n");

/** The changes the turn queued, in the order the model asked for them. */
export class Proposals {
  /** Slots by call order: a proposal still being built is `undefined`, a failed one `null`. */
  private slots: Array<Proposal | null | undefined> = [];
  /** The action stored at the end of the turn (or found, on a replay). */
  action: AgentPendingAction | null = null;

  constructor(private readonly options: ProposalsOptions) {}

  /** Queued proposals, in call order. */
  get queued(): Proposal[] {
    return this.slots.filter((slot): slot is Proposal => !!slot);
  }

  /**
   * A slot for a proposal, taken synchronously when the tool call starts, so
   * parallel calls keep the order the model made them in. Null when full.
   */
  reserve(): number | null {
    if (this.slots.filter((slot) => slot !== null).length >= MAX_PROPOSALS) return null;
    return this.slots.push(undefined) - 1;
  }

  release(slot: number): void {
    this.slots[slot] = null;
  }

  /** The API checks the input against the operation's own schema; nothing is stored yet. */
  async check(proposal: Proposal, signal?: AbortSignal): Promise<void> {
    await this.options.finance.agentPendingActions.check.mutate(
      { operation: proposal.operation, input: proposal.input as Record<string, never> },
      { signal },
    );
  }

  /** Queue a checked proposal. A repeat of one already queued takes no slot (the model retried it). */
  fill(slot: number, proposal: Proposal): "queued" | "duplicate" {
    const same = (other: Proposal | null | undefined) =>
      !!other && other.operation === proposal.operation && JSON.stringify(other.input) === JSON.stringify(proposal.input);
    if (this.slots.some(same)) {
      this.slots[slot] = null;
      return "duplicate";
    }
    const summaries = [...this.queued.map((p) => p.summary), proposal.summary];
    if (summaries.length > 1 && batchSummary(summaries).length > BATCH_SUMMARY_MAX) throw new SummaryTooLongError();
    this.slots[slot] = proposal;
    return "queued";
  }

  /**
   * Store what the turn queued: one action for one change, a `batch` for
   * several. The key is always `<eventId>:0`, so a replay of the event (boot
   * recovery) gets the same action back, whatever its status, instead of a second one.
   */
  async commit(signal?: AbortSignal): Promise<AgentPendingAction | null> {
    const queued = this.queued;
    if (queued.length === 0) return null;
    const sessionId = await this.options.sessionId(signal);
    const [first] = queued;
    const proposal =
      queued.length === 1
        ? { operation: first!.operation, input: first!.input as Record<string, never>, summary: first!.summary }
        : {
            operation: "batch" as const,
            input: { items: queued.map(({ operation, input }) => ({ operation, input })) } as unknown as Record<string, never>,
            summary: batchSummary(queued.map((p) => p.summary)),
          };
    const { action } = await this.options.finance.agentPendingActions.create.mutate(
      { sessionId, ...proposal, clientKey: `${this.options.eventId}:0` },
      { signal },
    );
    this.action = action;
    return action;
  }
}

export interface WriteContext {
  proposals: Proposals;
}

export interface Proposal {
  operation: Exclude<AgentActionOperation, "batch">;
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

export type ProposalResult = { status: "awaiting_confirmation"; summary: string; message?: string } | ToolError;

const TOO_MANY: ToolError = {
  error: "too_many",
  message: `At most ${MAX_PROPOSALS} changes can be proposed in one message. Tell the user which ones are waiting for confirmation and that you'll do the rest after they confirm.`,
};

/** Field paths and the schema's own messages only (the API's `validation_failed` issues): no input values. */
function issuesText(details: unknown): string | null {
  const issues = (details as { issues?: Array<{ path?: unknown; message?: unknown }> } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return issues
    .slice(0, 5)
    .map((issue) => (typeof issue.path === "string" && issue.path ? `${issue.path}: ${String(issue.message)}` : String(issue.message)))
    .join("; ");
}

/**
 * Run a write tool: take a slot, build the request, have the API check it,
 * then queue it for the turn's Confirm message. A failed proposal gives its
 * slot back, so the model can fix its input.
 */
export async function propose(context: ToolContext, write: WriteContext, build: () => Promise<Proposal>): Promise<ProposalResult> {
  const { proposals } = write;
  const slot = proposals.reserve();
  if (slot === null) return TOO_MANY;
  try {
    const proposal = await build();
    await proposals.check(proposal, context.signal);
    if (proposals.fill(slot, proposal) === "duplicate") {
      return { status: "awaiting_confirmation", summary: proposal.summary, message: "Already proposed in this message; don't propose it again." };
    }
    return { status: "awaiting_confirmation", summary: proposal.summary };
  } catch (error) {
    proposals.release(slot);
    if (error instanceof ProposalError) return { error: error.code, message: error.message };
    const issues = isFinanceError(error, "validation_failed") ? issuesText(error.details) : null;
    if (issues) return { error: "invalid_input", message: `Invalid request: ${issues}` };
    if (error instanceof SummaryTooLongError) {
      return {
        error: "too_long",
        message: "The confirmation can't show all of these changes at once. Ask the user to change fewer things at once (for example, the amount and date now, the rest next).",
      };
    }
    return toToolError(error, context);
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
      if (!accounts.has(id)) accounts.set(id, finance.accounts.get.query({ id }, call(context)).then((r) => r.account));
      return accounts.get(id)!;
    },
    /** An account the user can still write to. */
    async activeAccount(id: string): Promise<Account> {
      const account = await this.account(id);
      if (account.archived) throw new ProposalError("invalid_input", `The account "${shortText(account.name)}" is archived. Ask the user which active account to use.`);
      return account;
    },
    categories(): Promise<Category[]> {
      categories ??= finance.categories.list.query({ includeArchived: true }, call(context)).then((r) => r.items);
      return categories;
    },
    subcategories(): Promise<Subcategory[]> {
      subcategories ??= finance.subcategories.list.query({ includeArchived: true }, call(context)).then((r) => r.items);
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
