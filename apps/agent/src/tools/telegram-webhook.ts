import { TELEGRAM_WEBHOOK_PATH } from "../channels/telegram/adapter";

/** Updates the agent handles. Anything else Telegram would deliver is wasted traffic through the tunnel. */
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export type WebhookCommand = "set" | "info" | "delete";

type Env = Record<string, string | undefined>;

export class WebhookToolError extends Error {
  override name = "WebhookToolError";
}

export interface BotApiRequest {
  /** Contains the bot token. Never log it. */
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

const TOKEN_PATTERN = /^\d{1,20}:[A-Za-z0-9_-]{30,64}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

const clean = (env: Env, name: string) => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

const isTrue = (value: string | undefined) => value !== undefined && /^(1|true|yes)$/i.test(value);

function requireToken(env: Env): string {
  const token = clean(env, "TELEGRAM_BOT_TOKEN");
  if (!token) throw new WebhookToolError("TELEGRAM_BOT_TOKEN is required");
  if (!TOKEN_PATTERN.test(token)) throw new WebhookToolError("TELEGRAM_BOT_TOKEN must look like <id>:<secret> from BotFather");
  return token;
}

/** `AGENT_PUBLIC_URL` is an https origin; the webhook path is appended here so the two can't drift. */
export function webhookUrl(env: Env): string {
  const raw = clean(env, "AGENT_PUBLIC_URL");
  if (!raw) throw new WebhookToolError("AGENT_PUBLIC_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookToolError("AGENT_PUBLIC_URL must be a URL like https://agent.example.com");
  }
  if (url.protocol !== "https:") throw new WebhookToolError("AGENT_PUBLIC_URL must use https (Telegram only calls https webhooks)");
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, "") !== "") {
    throw new WebhookToolError(`AGENT_PUBLIC_URL must be an origin only, without path, query or credentials (${TELEGRAM_WEBHOOK_PATH} is appended)`);
  }
  return `${url.origin}${TELEGRAM_WEBHOOK_PATH}`;
}

function request(token: string, method: string, body: Record<string, unknown> = {}): BotApiRequest {
  return {
    url: `https://api.telegram.org/bot${token}/${method}`,
    init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  };
}

/** `setWebhook` with the secret header Telegram will echo back on every delivery. */
export function buildSetWebhook(env: Env): BotApiRequest {
  const token = requireToken(env);
  const secret = clean(env, "TELEGRAM_WEBHOOK_SECRET");
  if (!secret) throw new WebhookToolError("TELEGRAM_WEBHOOK_SECRET is required");
  if (!SECRET_PATTERN.test(secret)) throw new WebhookToolError("TELEGRAM_WEBHOOK_SECRET must be 32-256 chars of A-Z a-z 0-9 _ -");
  return request(token, "setWebhook", {
    url: webhookUrl(env),
    secret_token: secret,
    allowed_updates: [...ALLOWED_UPDATES],
    ...(isTrue(clean(env, "DROP_PENDING_UPDATES")) ? { drop_pending_updates: true } : {}),
  });
}

export function buildGetWebhookInfo(env: Env): BotApiRequest {
  return request(requireToken(env), "getWebhookInfo");
}

export function buildDeleteWebhook(env: Env): BotApiRequest {
  return request(requireToken(env), "deleteWebhook", isTrue(clean(env, "DROP_PENDING_UPDATES")) ? { drop_pending_updates: true } : {});
}

interface BotApiResult {
  ok: boolean;
  description?: string;
  result?: unknown;
}

/** Strings that must not reach the console, whatever Telegram or the network echoes back. */
function scrubber(env: Env) {
  const secrets = [clean(env, "TELEGRAM_BOT_TOKEN"), clean(env, "TELEGRAM_WEBHOOK_SECRET")].filter((value): value is string => !!value);
  return (text: string) => secrets.reduce((acc, secret) => acc.split(secret).join("[redacted]"), text);
}

async function call(req: BotApiRequest, fetchFn: typeof fetch, scrub: (text: string) => string): Promise<BotApiResult> {
  let response: Response;
  try {
    response = await fetchFn(req.url, req.init);
  } catch (error) {
    // Network errors can carry the request URL, which holds the token.
    throw new WebhookToolError(`request failed: ${scrub(error instanceof Error ? error.message : "unknown error")}`);
  }
  let body: BotApiResult;
  try {
    body = (await response.json()) as BotApiResult;
  } catch {
    throw new WebhookToolError(`Telegram answered HTTP ${response.status} with a non-JSON body`);
  }
  if (!body.ok) throw new WebhookToolError(`Telegram rejected the call (HTTP ${response.status}): ${scrub(body.description ?? "no description")}`);
  return body;
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  ip_address?: string;
  allowed_updates?: string[];
  has_custom_certificate?: boolean;
}

/** Host and path only: a query string or credentials in the URL could be secrets. */
function describeUrl(value: string | undefined): string {
  if (!value) return "(none)";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

export function formatWebhookInfo(info: WebhookInfo, scrub: (text: string) => string = (text) => text): string {
  const lines = [
    `url:             ${describeUrl(info.url)}`,
    `pending updates: ${info.pending_update_count ?? 0}`,
    `allowed updates: ${info.allowed_updates?.length ? info.allowed_updates.join(", ") : "(all)"}`,
    `max connections: ${info.max_connections ?? "(default)"}`,
  ];
  if (info.ip_address) lines.push(`ip address:      ${info.ip_address}`);
  if (info.last_error_date) {
    lines.push(`last error:      ${new Date(info.last_error_date * 1000).toISOString()} ${scrub(info.last_error_message ?? "")}`.trimEnd());
  } else {
    lines.push("last error:      none");
  }
  return lines.join("\n");
}

/** Runs one command; returns the process exit code. Output goes through `out`/`err`, never the token. */
export async function runWebhookCommand(
  command: string | undefined,
  env: Env,
  options: { fetch?: typeof fetch; out?: (line: string) => void; err?: (line: string) => void } = {},
): Promise<number> {
  const fetchFn = options.fetch ?? fetch;
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const scrub = scrubber(env);
  try {
    switch (command) {
      case "set": {
        const req = buildSetWebhook(env);
        await call(req, fetchFn, scrub);
        out(`webhook set: ${webhookUrl(env)}`);
        out(`allowed updates: ${ALLOWED_UPDATES.join(", ")}; drop pending updates: ${isTrue(clean(env, "DROP_PENDING_UPDATES")) ? "yes" : "no"}`);
        out("run `bun run telegram:webhook:info` to confirm Telegram can reach it");
        return 0;
      }
      case "info": {
        const body = await call(buildGetWebhookInfo(env), fetchFn, scrub);
        out(formatWebhookInfo((body.result ?? {}) as WebhookInfo, scrub));
        return 0;
      }
      case "delete": {
        await call(buildDeleteWebhook(env), fetchFn, scrub);
        out(`webhook deleted; pending updates ${isTrue(clean(env, "DROP_PENDING_UPDATES")) ? "dropped" : "kept"}`);
        return 0;
      }
      default:
        err("usage: telegram-webhook <set|info|delete>");
        return 2;
    }
  } catch (error) {
    if (error instanceof WebhookToolError) {
      err(`error: ${scrub(error.message)}`);
      return 1;
    }
    throw error;
  }
}
