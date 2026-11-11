import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { routes, type RouteDef } from "@mpf/finance-contract";

import { createTelegramAdapter, type TelegramApi } from "../src/channels/telegram/adapter";
import { createFinanceClients } from "../src/core/finance";
import { createLogger, type Logger } from "../src/log";

export const BOT_TOKEN = "7000000001:AAH-test-bot-token-0123456789abcdefXYZ";
export const SERVICE_KEY = "service-key-0123456789abcdef0123456789abcdef";
export const WEBHOOK_SECRET = "webhook-secret-0123456789abcdef0123456789";
export const BOT_USERNAME = "dalva_test_bot";
export const BASE_URL = "https://finance.test";

export function fixture(name: string): Record<string, any> {
  const path = fileURLToPath(new URL(`./fixtures/telegram/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Private text update from user `userId` in their private chat. */
export function textUpdate(updateId: number, text: string, userId = 424242, chatId = userId) {
  const isCommand = text.startsWith("/");
  const commandLength = isCommand ? text.split(/\s/)[0]!.length : 0;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: "User", username: `user${userId}` },
      chat: { id: chatId, type: chatId === userId ? "private" : "supergroup" },
      date: 1762860000,
      text,
      ...(isCommand ? { entities: [{ offset: 0, length: commandLength, type: "bot_command" }] } : {}),
    },
  };
}

export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    secrets: [BOT_TOKEN, SERVICE_KEY, WEBHOOK_SECRET],
    write: (line) => lines.push(line),
  });
  return { logger, lines };
}

export interface SentMessage {
  chatId: string;
  html: string;
  replyMarkup?: unknown;
}

/** Records Bot API calls instead of talking to Telegram. */
export function fakeTelegramApi() {
  const sent: SentMessage[] = [];
  const actions: Array<{ chatId: string; action: string }> = [];
  const answered: Array<{ id: string; text?: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; html: string; replyMarkup?: unknown }> = [];
  let editFailure: string | null = null;
  const api = {
    sendMessage: async (chatId: number | string, text: string, other?: { reply_markup?: unknown }) => {
      sent.push({ chatId: String(chatId), html: text, replyMarkup: other?.reply_markup });
      return { message_id: sent.length } as never;
    },
    editMessageText: async (chatId: number | string, messageId: number, text: string, other?: { reply_markup?: unknown }) => {
      if (editFailure) {
        const description = editFailure;
        editFailure = null;
        throw Object.assign(new Error(description), { description, error_code: 400 });
      }
      edited.push({ chatId: String(chatId), messageId, html: text, replyMarkup: other?.reply_markup });
      return true as never;
    },
    sendChatAction: async (chatId: number | string, action: string) => {
      actions.push({ chatId: String(chatId), action });
      return true as const;
    },
    answerCallbackQuery: async (id: string, other?: { text?: string }) => {
      answered.push({ id, text: other?.text });
      return true as const;
    },
    getUpdates: async () => [],
    deleteWebhook: async () => true as const,
  } as unknown as TelegramApi;
  return {
    api,
    sent,
    actions,
    answered,
    edited,
    /** The next `editMessageText` fails with this Bot API description. */
    failEdit: (description: string) => {
      editFailure = description;
    },
  };
}

export function telegramAdapter(logger: Logger, mode: "webhook" | "polling" = "webhook") {
  const telegram = fakeTelegramApi();
  const adapter = createTelegramAdapter({
    token: BOT_TOKEN,
    botUsername: BOT_USERNAME,
    mode,
    webhookSecret: WEBHOOK_SECRET,
    logger,
    api: telegram.api,
  });
  return { adapter, telegram };
}

/* -------------------------------------------------------------------------- */
/*  Fake Finance API: speaks the contract's envelopes over a mocked fetch.     */
/* -------------------------------------------------------------------------- */

type Json = Record<string, any>;
type ErrorCode = "unauthorized" | "forbidden" | "not_found" | "validation_failed" | "conflict" | "rate_limited" | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export class ApiFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

export interface FakeIdentity {
  externalUserId: string;
  chatId: string;
  token: string;
  scopes: Array<"finance:read" | "finance:write">;
  displayName?: string;
}

export interface FakeEvent {
  eventId: string;
  status: "received" | "processing" | "done" | "failed";
  attempts: number;
  payload?: string;
  error?: string;
  /** ISO; defaults to when the fake lists it (i.e. fresh). */
  receivedAt?: string;
}

export interface Call {
  method: string;
  path: string;
  body?: Json;
  auth: string | null;
  idempotencyKey: string | null;
}

export interface FakeAction {
  id: string;
  sessionId: string;
  clientKey?: string;
  operation: string;
  input: Json;
  summary: string;
  status: "pending" | "confirmed" | "cancelled" | "expired" | "executed" | "failed";
  expiresAt: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
  /** Owner (identity external id): another chat's token gets `not_found`. */
  owner: string;
}

/** Finance writes the fake executes, by `METHOD /path` pattern -> contract operation name. */
const WRITE_ROUTES: Array<[RegExp, string, string]> = [
  [/^\/transactions$/, "POST", "transactions.create"],
  [/^\/transactions\/([^/]+)$/, "PATCH", "transactions.update"],
  [/^\/transactions\/([^/]+)$/, "DELETE", "transactions.delete"],
  [/^\/transfers$/, "POST", "transfers.create"],
  [/^\/transfers\/([^/]+)$/, "DELETE", "transfers.delete"],
  [/^\/goals\/([^/]+)\/contributions$/, "POST", "goalContributions.add"],
  [/^\/debts\/([^/]+)\/payments$/, "POST", "debtPayments.record"],
];

const routeOf = (operation: string): RouteDef => {
  const [group, op] = operation.split(".");
  return (routes as unknown as Record<string, Record<string, RouteDef>>)[group!]![op!]!;
};

const ISO = "2026-11-11T00:00:00.000Z";

/**
 * In-memory Finance API. Routes are matched on method + path; every
 * response is an envelope the real contract client parses with its schemas.
 */
export function fakeFinance() {
  const calls: Call[] = [];
  const identities = new Map<string, FakeIdentity>();
  const codes = new Map<string, "valid">();
  const events = new Map<string, FakeEvent>();
  const accounts: Json[] = [];
  /** Read-route data. A function is called with the request (query) to build `data`. */
  const reads = new Map<string, Json | ((query: Json) => Json)>();
  const sessions: Json[] = [];
  const messages: Json[] = [];
  const actions: FakeAction[] = [];
  /** Executed finance writes, one per distinct Idempotency-Key. */
  const writes: Array<{ operation: string; input: Json; idempotencyKey: string | null }> = [];
  const writeReplies = new Map<string, unknown>();
  let historyDeletes = 0;
  /** Force an error for `METHOD /path` (path without /api/v1), once or always. */
  const failures = new Map<string, { code: ErrorCode | "network" | "network_after"; times: number; details?: unknown }>();
  /** Hold a route until the returned function is called. */
  const gates = new Map<string, Promise<void>>();

  const identityByToken = (auth: string | null) =>
    [...identities.values()].find((identity) => auth === `Bearer ${identity.token}`);

  const identityJson = (identity: FakeIdentity) => ({
    id: `ident_${identity.externalUserId}`,
    channel: "telegram",
    externalUserId: identity.externalUserId,
    chatId: identity.chatId,
    scopes: identity.scopes,
    linkedAt: ISO,
    consentAt: ISO,
  });

  const eventJson = (event: FakeEvent) => ({
    channel: "telegram",
    eventId: event.eventId,
    status: event.status,
    attempts: event.attempts,
    ...(event.error ? { error: event.error } : {}),
    receivedAt: event.receivedAt ?? new Date().toISOString(),
    updatedAt: ISO,
  });

  function service(path: string, body: Json): unknown {
    switch (path) {
      case "/channel-links/redeem": {
        if (!codes.has(body.code)) throw new ApiFailure("not_found");
        if (body.chatId !== body.externalUserId) throw new ApiFailure("validation_failed");
        if (identities.has(body.externalUserId)) throw new ApiFailure("conflict");
        codes.delete(body.code);
        const identity: FakeIdentity = {
          externalUserId: body.externalUserId,
          chatId: body.chatId,
          token: `tok_${body.externalUserId}`,
          scopes: ["finance:read", "finance:write"],
        };
        identities.set(body.externalUserId, identity);
        return { identity: identityJson(identity) };
      }
      case "/channel-identities/resolve": {
        const identity = identities.get(body.externalUserId);
        if (!identity || identity.chatId !== body.chatId) throw new ApiFailure("not_found");
        return {
          token: identity.token,
          expiresAt: ISO,
          scopes: [...identity.scopes, "agent:state"],
          identity: identityJson(identity),
          profile: { ...(identity.displayName ? { displayName: identity.displayName } : {}), baseCurrency: "USD" },
        };
      }
      case "/channel-identities/unlink": {
        const identity = identities.get(body.externalUserId);
        if (!identity) throw new ApiFailure("not_found");
        identities.delete(body.externalUserId);
        return { id: `ident_${identity.externalUserId}` };
      }
      case "/agent/events/claim": {
        if (events.has(body.eventId)) return { status: "duplicate" };
        events.set(body.eventId, { eventId: body.eventId, status: "received", attempts: 0, payload: body.payload });
        return { status: "new" };
      }
      case "/agent/events/status": {
        const event = events.get(body.eventId);
        if (!event) throw new ApiFailure("not_found");
        if (event.status === "done" || event.status === "failed") throw new ApiFailure("conflict");
        event.status = body.status;
        if (body.status === "processing") event.attempts += 1;
        if (body.error) event.error = body.error;
        if (body.status !== "processing") delete event.payload;
        return { event: eventJson(event) };
      }
    }
    throw new Error(`fake: no service route ${path}`);
  }

  const canWrite = (identity: FakeIdentity) => identity.scopes.includes("finance:write");

  const actionJson = (action: FakeAction) => {
    const { owner: _owner, ...json } = action;
    return json;
  };

  function ownAction(id: string, identity: FakeIdentity): FakeAction {
    const action = actions.find((a) => a.id === id && a.owner === identity.externalUserId);
    if (!action) throw new ApiFailure("not_found");
    return action;
  }

  function pendingActions(method: string, path: string, body: Json, identity: FakeIdentity): unknown {
    if (method === "POST" && path === "/agent/pending-actions") {
      if (!canWrite(identity)) throw new ApiFailure("forbidden");
      if (!sessions.some((s) => s.id === body.sessionId)) throw new ApiFailure("not_found");
      if (body.clientKey) {
        const existing = actions.find((a) => a.sessionId === body.sessionId && a.clientKey === body.clientKey);
        if (existing) return { action: actionJson(existing) };
      }
      const parsed = routeOf(String(body.operation)).request.safeParse(body.input);
      if (!parsed.success) throw new ApiFailure("validation_failed");
      const action: FakeAction = {
        id: `action_${actions.length + 1}`,
        sessionId: body.sessionId,
        ...(body.clientKey ? { clientKey: body.clientKey } : {}),
        operation: body.operation,
        input: parsed.data as Json,
        summary: body.summary,
        status: "pending",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        createdAt: ISO,
        updatedAt: ISO,
        owner: identity.externalUserId,
      };
      actions.push(action);
      return { action: actionJson(action) };
    }
    const match = /^\/agent\/pending-actions\/([^/]+)(?:\/(confirm|cancel|complete))?$/.exec(path);
    if (!match) return undefined;
    const [, id, verb] = match;
    if (!verb && method === "GET") return { action: actionJson(ownAction(id!, identity)) };
    if (verb === "confirm" && !canWrite(identity)) throw new ApiFailure("forbidden");
    const action = ownAction(id!, identity);
    if (verb === "confirm" || verb === "cancel") {
      if (action.status === "pending" && Date.parse(action.expiresAt) <= Date.now()) action.status = "expired";
      if (action.status !== "pending") throw new ApiFailure("conflict");
      action.status = verb === "confirm" ? "confirmed" : "cancelled";
      return { action: actionJson(action) };
    }
    if (verb === "complete") {
      if (action.status !== "confirmed") throw new ApiFailure("conflict");
      action.status = body.status;
      action.result = body.result;
      return { action: actionJson(action) };
    }
    return undefined;
  }

  /** Executes a finance write once per Idempotency-Key; a repeat replays the stored reply. */
  function financeWrite(method: string, path: string, body: Json, key: string | null): unknown {
    for (const [pattern, verb, operation] of WRITE_ROUTES) {
      const match = verb === method ? pattern.exec(path) : null;
      if (!match) continue;
      if (key && writeReplies.has(key)) return writeReplies.get(key);
      const param = match[1];
      const input: Json = { ...body };
      if (operation.startsWith("goalContributions")) input.goalId = param;
      else if (operation.startsWith("debtPayments")) input.debtId = param;
      else if (param) input.id = param;
      writes.push({ operation, input, idempotencyKey: key });
      const reply = writeReply(operation, input);
      if (key) writeReplies.set(key, reply);
      return reply;
    }
    return undefined;
  }

  function writeReply(operation: string, input: Json): unknown {
    const date = input.date ?? "2026-11-11";
    switch (operation) {
      case "transactions.create":
        return { transaction: { id: `tx_new_${writes.length}`, ...input, date } };
      case "transactions.update": {
        const current = reads.get(`/transactions/${input.id}`) as Json | undefined;
        return { transaction: { ...(current?.transaction ?? { type: "expense", amount: { amountMinor: 1, currency: "AOA" }, accountId: "acc_bai", date }), ...input } };
      }
      case "transactions.delete":
      case "transfers.delete":
        return { id: input.id };
      case "transfers.create":
        return {
          transfer: {
            outgoingId: `tx_out_${writes.length}`,
            incomingId: `tx_in_${writes.length}`,
            amount: input.amount,
            fromAccountId: input.fromAccountId,
            toAccountId: input.toAccountId,
            fromAccountName: "from",
            toAccountName: "to",
            date,
          },
        };
      case "goalContributions.add":
        return { contribution: { id: `gc_${writes.length}`, goalId: input.goalId, amount: input.amount, date } };
      case "debtPayments.record":
        return {
          payment: {
            id: `dp_${writes.length}`,
            debtId: input.debtId,
            amount: input.amount,
            principalAmount: input.principalAmount ?? input.amount,
            interestAmount: input.interestAmount ?? { amountMinor: 0, currency: input.amount.currency },
            date,
            fromAccountId: input.fromAccountId,
            sourceTransactionId: `tx_dp_${writes.length}`,
          },
        };
    }
    throw new Error(`fake: no reply for ${operation}`);
  }

  function user(method: string, path: string, body: Json, identity: FakeIdentity, key: string | null): unknown {
    if (method === "GET" && path === "/accounts") return { items: accounts };
    const account = /^\/accounts\/([^/]+)$/.exec(path);
    if (method === "GET" && account) {
      const found = accounts.find((a) => a.id === account[1]);
      if (!found) throw new ApiFailure("not_found");
      return { account: found };
    }
    if (path.startsWith("/agent/pending-actions")) {
      const result = pendingActions(method, path, body, identity);
      if (result !== undefined) return result;
    }
    if (method !== "GET" && !path.startsWith("/agent/")) {
      if (!canWrite(identity)) throw new ApiFailure("forbidden");
      const result = financeWrite(method, path, body, key);
      if (result !== undefined) return result;
    }
    if (method === "GET" && reads.has(path)) {
      const read = reads.get(path)!;
      return typeof read === "function" ? read(body) : read;
    }
    const list = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(path);
    if (method === "GET" && list) {
      const items = messages.filter((m) => m.sessionId === list[1]);
      return { items: items.slice(-Number(body.limit ?? 50)) };
    }
    if (method === "POST" && path === "/agent/sessions/current") {
      let session = sessions.find((s) => s.chatId === body.chatId && !s.endedAt);
      if (body.startNew && session) {
        session.endedAt = ISO;
        session = undefined;
      }
      const created = !session;
      if (!session) {
        session = {
          id: `sess_${sessions.length + 1}`,
          channel: "telegram",
          chatId: identity.chatId,
          startedAt: ISO,
          lastActivityAt: ISO,
          messageCount: 0,
        };
        sessions.push(session);
      }
      return { session, created };
    }
    const append = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(path);
    if (method === "POST" && append) {
      const session = sessions.find((s) => s.id === append[1]);
      if (!session) throw new ApiFailure("not_found");
      if (session.endedAt) throw new ApiFailure("conflict");
      const items = (body.messages as Json[]).map((message) => {
        session.messageCount += 1;
        const stored = {
          id: `msg_${messages.length + 1}`,
          sessionId: session.id,
          role: message.role,
          content: message.content,
          seq: session.messageCount,
          createdAt: ISO,
        };
        messages.push(stored);
        return stored;
      });
      return { items };
    }
    if (method === "DELETE" && path === "/agent/history") {
      historyDeletes += 1;
      for (const session of sessions) session.endedAt = ISO;
      messages.length = 0;
      return { deleted: true };
    }
    if (method === "GET" && /^\/(transactions|goals|debts)\/[^/]+$/.test(path)) throw new ApiFailure("not_found");
    throw new Error(`fake: no user route ${method} ${path}`);
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    const idempotencyKey = headers.get("Idempotency-Key");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : Object.fromEntries(url.searchParams);
    calls.push({ method, path, body, auth, idempotencyKey });

    const key = `${method} ${path}`;
    const gate = gates.get(key);
    if (gate) {
      // Like real fetch: an aborted signal rejects a request that is still waiting.
      const signal = init?.signal;
      await Promise.race([
        gate,
        new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    }

    const failure = failures.get(key);
    let lostReply = false;
    if (failure && failure.times > 0) {
      failure.times -= 1;
      if (failure.code === "network") throw new TypeError("fetch failed");
      // "network_after": the server applies the request, then the reply is lost.
      if (failure.code === "network_after") lostReply = true;
      else {
        const error = { code: failure.code, message: failure.code, ...(failure.details ? { details: failure.details } : {}) };
        return envelope({ ok: false, error }, STATUS[failure.code]);
      }
    }

    try {
      let data: unknown;
      if (path === "/agent/events/recoverable") {
        if (auth !== `Bearer ${SERVICE_KEY}`) throw new ApiFailure("unauthorized");
        const items = [...events.values()]
          .filter((event) => (event.status === "received" || event.status === "processing") && event.attempts < Number(body.maxAttempts ?? 3))
          .map((event) => ({ ...eventJson(event), payload: event.payload ?? "{}" }))
          .slice(0, Number(body.limit ?? 20));
        data = { items };
      } else if (path.startsWith("/channel-") || path.startsWith("/agent/events/")) {
        if (auth !== `Bearer ${SERVICE_KEY}`) throw new ApiFailure("unauthorized");
        data = service(path, body);
      } else {
        const identity = identityByToken(auth);
        if (!identity) throw new ApiFailure("unauthorized");
        data = user(method, path, body, identity, idempotencyKey);
      }
      if (lostReply) throw new TypeError("fetch failed");
      return envelope({ ok: true, data }, 200);
    } catch (error) {
      if (error instanceof ApiFailure) {
        return envelope({ ok: false, error: { code: error.code, message: error.code } }, STATUS[error.code]);
      }
      throw error;
    }
  }) as typeof fetch;

  const clients = createFinanceClients({ baseUrl: BASE_URL, serviceKey: SERVICE_KEY, fetch: fetchImpl });

  return {
    fetch: fetchImpl,
    clients,
    calls,
    identities,
    codes,
    events,
    accounts,
    reads,
    sessions,
    messages,
    actions,
    writes,
    get historyDeletes() {
      return historyDeletes;
    },
    link(externalUserId: string, extra: Partial<FakeIdentity> = {}) {
      const identity: FakeIdentity = {
        externalUserId,
        chatId: externalUserId,
        token: `tok_${externalUserId}`,
        scopes: ["finance:read", "finance:write"],
        ...extra,
      };
      identities.set(externalUserId, identity);
      return identity;
    },
    fail(key: string, code: ErrorCode | "network" | "network_after", times = 1, details?: unknown) {
      failures.set(key, { code, times, details });
    },
    hold(key: string): () => void {
      let release!: () => void;
      gates.set(key, new Promise<void>((resolve) => (release = resolve)));
      return () => {
        gates.delete(key);
        release();
      };
    },
    callsTo(path: string) {
      return calls.filter((call) => call.path === path || call.path.startsWith(`${path}?`));
    },
  };
}

function envelope(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
