
import { decodeButtonPayload, type ChannelAdapter, type InboundEvent, type RichText } from "../channels/channel";
import { errorFields, type Logger } from "../log";
import { type AgentActionStatus, type AgentPendingAction, type FinanceClient, isFinanceError } from "./finance";
import { encodeAssistantText } from "./history";
import type { ResolvedUser } from "./identity";
import { texts } from "./messages";
import { plainText, SessionRecorder } from "./session";
import { summaryLanguage, type Language } from "./summary";

/**
 * Confirm/Cancel buttons of a proposed change.
 *
 * Confirm: `confirm` (atomic pending -> confirmed) -> run the stored operation
 * with the action id as `Idempotency-Key` -> `complete`. A second `confirm` is a
 * `conflict`: then `get` tells whether a crash left it `confirmed` (run it again
 * with the same key, which the API replays) or it is already final (show that).
 * The backend scopes actions by the user token, so an action id from another
 * chat or user is `not_found`.
 */

export interface ButtonOptions {
  adapter: ChannelAdapter;
  logger: Logger;
  sessionIdleMinutes: number;
  /** Pause before retrying an ambiguous execution (times the attempt). */
  retryDelayMs?: number;
}

/**
 * A `confirmed` action is only re-run while the API still holds its
 * idempotency key (kept 7 days); 6 days leaves a margin.
 */
const RERUN_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** Ambiguous outcomes are retried this many times with the same key. */
const EXECUTE_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** No answer, or one we can't trust: the write may or may not have run. */
const isAmbiguous = (error: unknown) => isFinanceError(error, "network_error", "timeout", "aborted", "internal", "invalid_response");

const ACTION_TEXTS = {
  pt: {
    saved: "✅ Guardado",
    alreadySaved: "✅ Já guardado",
    notSaved: "❌ Não guardado",
    partlySaved: "⚠️ Guardado em parte",
    mayBeSaved: "pode ter sido guardado, verifica no DALVA",
    failedBefore: "❌ Esta alteração falhou",
    uncertain: "⚠️ Pode ter sido guardado. Verifica no DALVA antes de tentar de novo.",
    cancelled: "Cancelado",
    expired: "⌛ Expirou. Pede-me de novo se ainda quiseres.",
    confirming: "⏳ Já confirmado, a guardar.",
    readOnly: "🔒 Este chat agora é só de leitura. Para fazer alterações, ativa a escrita em DALVA → Settings → Telegram.",
    reasons: {
      validation_failed: "Os dados já não são válidos (uma conta ou categoria pode ter mudado).",
      not_found: "Algo a que se refere foi apagado.",
      conflict: "Entra em conflito com os dados atuais.",
      rate_limited: "Demasiados pedidos. Tenta de novo daqui a pouco.",
      forbidden: "Este chat agora é só de leitura.",
      other: "Ocorreu um erro.",
    },
  },
  en: {
    saved: "✅ Saved",
    alreadySaved: "✅ Already saved",
    notSaved: "❌ Not saved",
    partlySaved: "⚠️ Partly saved",
    mayBeSaved: "may have been saved, check DALVA",
    failedBefore: "❌ This change failed",
    uncertain: "⚠️ This may have been saved. Check DALVA before trying again.",
    cancelled: "Cancelled",
    expired: "⌛ Expired. Ask me again if you still want it.",
    confirming: "⏳ Already confirmed, saving.",
    readOnly: "🔒 This chat is read-only now. To make changes, allow writes in DALVA → Settings → Telegram.",
    reasons: {
      validation_failed: "The data is no longer valid (an account or category may have changed).",
      not_found: "Something it refers to was deleted.",
      conflict: "It conflicts with the current data.",
      rate_limited: "Too many requests. Try again in a moment.",
      forbidden: "This chat is read-only now.",
      other: "Something went wrong.",
    },
  },
} as const;

type Outcome = { status: "executed"; result: unknown } | { status: "failed"; code: string; uncertain?: boolean };

/** How each change of a batch ended, in order (stored in the action's result as `items`). */
type ItemOutcome = { status: "executed" } | { status: "failed"; error: string; uncertain?: boolean };

/** A batch's outcome carries one entry per item. */
type ActionOutcome = Outcome & { items?: ItemOutcome[] };

interface BatchItem {
  operation: string;
  input: unknown;
}

const batchItems = (action: Pick<AgentPendingAction, "input">): BatchItem[] => (action.input as { items?: BatchItem[] }).items ?? [];

/** Per-item outcomes stored in a batch action's result, if any. */
function storedItems(result: unknown): ItemOutcome[] | null {
  const items = typeof result === "object" && result !== null ? (result as { items?: unknown }).items : undefined;
  return Array.isArray(items) ? (items as ItemOutcome[]) : null;
}

/** The procedure an operation names (`transactions.create`), run with the action id as its `Idempotency-Key`. */
function operationCall(finance: FinanceClient, operation: string) {
  const [group, op] = operation.split(".") as [string, string];
  const procedure = (finance as unknown as Record<string, Record<string, { mutate: (input: unknown, options: object) => Promise<unknown> }>>)[group]?.[op];
  if (!procedure) throw new Error(`Unknown operation ${operation}`);
  return (input: unknown, options: { idempotencyKey: string }) => procedure.mutate(input, { context: { idempotencyKey: options.idempotencyKey } });
}

/** A stored failure whose write may still have landed (ambiguous attempts, or a rerun refused too late). */
const isUncertain = (result: unknown) =>
  typeof result === "object" && result !== null && (result as { uncertain?: unknown }).uncertain === true;

/** Message for an action that can't be confirmed any more. Keeps an uncertain failure's warning. */
function stateLine(status: AgentActionStatus, language: Language, result?: unknown): string {
  const t = ACTION_TEXTS[language];
  if (status === "failed" && isUncertain(result)) return t.uncertain;
  switch (status) {
    case "executed":
      return t.alreadySaved;
    case "failed":
      return t.failedBefore;
    case "cancelled":
      return t.cancelled;
    case "expired":
      return t.expired;
    case "confirmed":
      return t.confirming;
    case "pending":
      return "";
  }
}

/** Header + summary (+ detail): what the confirm message turns into. */
const resultMessage = (header: string, summary: string, detail?: string): RichText => [
  { bold: header },
  `\n${summary}`,
  ...(detail ? [`\n${detail}`] : []),
];

/** Whether all, some or none of a batch's changes were saved. */
function batchHeader(items: ItemOutcome[], language: Language): string {
  const t = ACTION_TEXTS[language];
  const saved = items.filter((item) => item.status === "executed").length;
  if (saved === items.length) return t.saved;
  const maybe = items.some((item) => item.status === "failed" && item.uncertain);
  return saved === 0 && !maybe ? t.notSaved : t.partlySaved;
}

/** A batch's result, one line per change: `✅ 1. Despesa …`, `❌ 2. Receita … (reason)`. */
function batchResultMessage(summary: string, items: ItemOutcome[], language: Language): RichText {
  const t = ACTION_TEXTS[language];
  const lines = summary.split("\n");
  const header = batchHeader(items, language);
  const body = lines.map((line, index) => {
    const item = items[index];
    if (!item) return line;
    if (item.status === "executed") return `✅ ${line}`;
    if (item.uncertain) return `⚠️ ${line} (${t.mayBeSaved})`;
    return `❌ ${line} (${t.reasons[item.error as keyof typeof t.reasons] ?? t.reasons.other})`;
  });
  return resultMessage(header, body.join("\n"));
}

/** Text for an action that is no longer pending, as the chat shows it (also used when a turn is replayed). */
export function actionStateMessage(action: Pick<AgentPendingAction, "status" | "summary" | "result">): RichText {
  const items = storedItems(action.result);
  if (items && (action.status === "executed" || action.status === "failed")) {
    return batchResultMessage(action.summary, items, summaryLanguage(action.summary));
  }
  return resultMessage(stateLine(action.status, summaryLanguage(action.summary), action.result), action.summary);
}

export async function handleButton(event: InboundEvent, user: ResolvedUser | null, options: ButtonOptions): Promise<void> {
  const { adapter } = options;
  const log = options.logger;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const to = { chatId: event.chatId };

  const answer = async (text?: string) => {
    if (!event.buttonId) return;
    try {
      await adapter.answerButton(event.buttonId, text);
    } catch (error) {
      log.warn("button_answer_failed", errorFields(error));
    }
  };

  const decoded = event.buttonPayload ? decodeButtonPayload(event.buttonPayload) : null;
  if (!decoded) {
    await answer(texts.buttonUnavailable());
    return;
  }
  if (!user) {
    await answer(texts.buttonNotLinked());
    return;
  }
  const { finance } = user;
  const id = decoded.actionId;

  /** Replace the confirm message (buttons removed); a new message when it can't be edited. */
  async function show(message: RichText) {
    if (event.messageRef) {
      try {
        await adapter.editMessage(to, event.messageRef, { type: "text", text: message });
        return;
      } catch (error) {
        log.warn("button_edit_failed", errorFields(error));
      }
    }
    await adapter.send(to, { type: "text", text: message });
  }

  /** Show the result, answer the press, and leave a note in the session so the model knows next turn. */
  async function finish(message: RichText, toast: string) {
    await show(message);
    await answer(toast);
    const recorder = new SessionRecorder(finance, event, options.sessionIdleMinutes, log);
    await recorder.recordAll([encodeAssistantText(`[${decoded!.action === "confirm" ? "Confirm" : "Cancel"} button] ${plainText(message)}`)]);
  }

  /** The action's current state, after a `conflict`. Null when it's gone. */
  async function current(): Promise<AgentPendingAction | null> {
    try {
      return (await finance.agentPendingActions.get.query({ id })).action;
    } catch (error) {
      if (isFinanceError(error, "not_found")) return null;
      throw error;
    }
  }

  async function gone() {
    log.info("action_not_found");
    await finish(texts.actionGone(), texts.actionGone());
  }

  if (decoded.action === "cancel") {
    let action: AgentPendingAction | null;
    try {
      action = (await finance.agentPendingActions.cancel.mutate({ id })).action;
    } catch (error) {
      if (isFinanceError(error, "not_found")) return gone();
      if (!isFinanceError(error, "conflict")) throw error;
      action = await current();
      if (!action) return gone();
      log.info("action_cancel_conflict", { status: action.status });
      const line = stateLine(action.status, summaryLanguage(action.summary), action.result);
      return finish(actionStateMessage(action), line);
    }
    log.info("action_cancelled");
    const line = ACTION_TEXTS[summaryLanguage(action.summary)].cancelled;
    return finish(resultMessage(line, action.summary), line);
  }

  let action: AgentPendingAction | null;
  try {
    action = (await finance.agentPendingActions.confirm.mutate({ id })).action;
  } catch (error) {
    if (isFinanceError(error, "not_found")) return gone();
    if (isFinanceError(error, "forbidden")) {
      // Read-only now. The action stays pending (and expires); `get` only needs agent:state.
      const known = await current().catch(() => null);
      const language = known ? summaryLanguage(known.summary) : "en";
      log.info("action_forbidden");
      const line = ACTION_TEXTS[language].readOnly;
      return finish(known ? resultMessage(line, known.summary) : line, line);
    }
    if (!isFinanceError(error, "conflict")) throw error;
    action = await current();
    if (!action) return gone();
    log.info("action_confirm_conflict", { status: action.status });
    if (action.status !== "confirmed") {
      const line = stateLine(action.status, summaryLanguage(action.summary), action.result);
      return finish(actionStateMessage(action), line);
    }
    // Confirmed but never completed (a crash, or a lost reply): run it again with the same key,
    // unless the API may have purged that key already: then a rerun could write twice.
    if (Date.now() - Date.parse(action.updatedAt) > RERUN_WINDOW_MS) {
      log.warn("action_rerun_too_late");
      const t = ACTION_TEXTS[summaryLanguage(action.summary)];
      await complete(finance, action.id, { status: "failed", code: "rerun_window_passed", uncertain: true }, log);
      return finish(resultMessage(t.uncertain, action.summary), t.uncertain);
    }
  }

  const outcome = await execute(finance, action, retryDelayMs, log);
  await complete(finance, action.id, outcome, log);

  const t = ACTION_TEXTS[summaryLanguage(action.summary)];
  if (outcome.items) {
    const language = summaryLanguage(action.summary);
    return finish(batchResultMessage(action.summary, outcome.items, language), batchHeader(outcome.items, language));
  }
  if (outcome.status === "executed") return finish(resultMessage(t.saved, action.summary), t.saved);
  if (outcome.uncertain) return finish(resultMessage(t.uncertain, action.summary), t.uncertain);
  const reason = t.reasons[outcome.code as keyof typeof t.reasons] ?? t.reasons.other;
  return finish(resultMessage(t.notSaved, action.summary, reason), t.notSaved);
}

/**
 * Run the stored operation. A batch runs its items in order, item `i` with
 * `Idempotency-Key = <action id>:<i>`; one failing doesn't stop the others.
 * A rerun (crash after confirm) replays the items that already ran.
 */
async function execute(finance: FinanceClient, action: AgentPendingAction, retryDelayMs: number, log: Logger): Promise<ActionOutcome> {
  if (action.operation !== "batch") return runWrite(finance, action.operation, action.input, action.id, retryDelayMs, log);
  const items: ItemOutcome[] = [];
  for (const [index, item] of batchItems(action).entries()) {
    const outcome = await runWrite(finance, item.operation, item.input, `${action.id}:${index}`, retryDelayMs, log);
    items.push(outcome.status === "executed" ? { status: "executed" } : { status: "failed", error: outcome.code, ...(outcome.uncertain ? { uncertain: true } : {}) });
  }
  const failed = items.filter((item): item is Extract<ItemOutcome, { status: "failed" }> => item.status === "failed");
  log.info("batch_executed", { items: items.length, failed: failed.length });
  // The stored result keeps only the per-item outcomes: a batch of full responses could pass the size limit.
  if (failed.length === 0) return { status: "executed", result: { items }, items };
  return {
    status: "failed",
    code: failed.length === items.length ? failed[0]!.error : "partial",
    ...(failed.some((item) => item.uncertain) ? { uncertain: true } : {}),
    items,
  };
}

/** One write; ambiguous failures are retried with the same key (the API replays a write it already did). */
async function runWrite(finance: FinanceClient, operation: string, input: unknown, idempotencyKey: string, retryDelayMs: number, log: Logger): Promise<Outcome> {
  const run = operationCall(finance, operation);
  // Once an attempt may have landed, a later refusal (read-only, unlink, rate limit) proves nothing about it.
  let sawAmbiguous = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await run(input, { idempotencyKey });
      log.info("action_executed", { operation, attempts: attempt + 1 });
      return { status: "executed", result };
    } catch (error) {
      const ambiguous = isAmbiguous(error);
      sawAmbiguous ||= ambiguous;
      if (ambiguous && attempt < EXECUTE_RETRIES) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      const code = isFinanceError(error) ? error.code : "internal";
      log.warn("action_failed", { ...errorFields(error), operation, attempts: attempt + 1, uncertain: sawAmbiguous || undefined });
      return { status: "failed", code, ...(sawAmbiguous ? { uncertain: true } : {}) };
    }
  }
}

/** `complete`, best effort: retried while ambiguous. `conflict` means an earlier try landed; `not_found`, that history was deleted meanwhile. */
async function complete(finance: FinanceClient, id: string, outcome: ActionOutcome, log: Logger) {
  const result =
    outcome.status === "executed"
      ? (outcome.result ?? null)
      : { error: outcome.code, ...(outcome.uncertain ? { uncertain: true } : {}), ...(outcome.items ? { items: outcome.items } : {}) };
  for (let attempt = 0; attempt <= EXECUTE_RETRIES; attempt++) {
    try {
      await finance.agentPendingActions.complete.mutate({ id, status: outcome.status, result: result as never });
      return;
    } catch (error) {
      if (isAmbiguous(error) && attempt < EXECUTE_RETRIES) continue;
      if (!isFinanceError(error, "conflict", "not_found")) log.warn("action_complete_failed", errorFields(error));
      return;
    }
  }
}
