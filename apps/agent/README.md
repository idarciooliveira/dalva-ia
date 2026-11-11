# @mpf/agent

Telegram bot for DALVA. Bun + Hono, one long-running process. Stateless: events, sessions and messages live in the backend, reached only through `@mpf/finance-contract` (never Convex directly).

## Env

Validated at boot; a bad or missing value exits with the variable names (never the values). See `.env.example`.

| Var | |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `TELEGRAM_MODE` | `webhook` (prod) or `polling` (local dev) |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook mode only. 32-256 chars `[A-Za-z0-9_-]`, also passed as `secret_token` to `setWebhook` |
| `TELEGRAM_BOT_USERNAME` | Without `@`; commands addressed to other bots are ignored |
| `FINANCE_API_URL` | Finance API origin (Convex site URL) |
| `FINANCE_API_SERVICE_KEY` | Same as the backend's `FINANCE_API_SERVICE_KEY` |
| `PORT` | Default `8080` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`, default `info` |
| `SESSION_IDLE_MINUTES` | Idle time before a chat starts a new session, default `30` |
| `RECOVERY_MAX_AGE_SECONDS` | Boot recovery replays only events received within this window, default `120` |
| `AI_PROVIDER` | `gateway` (Vercel AI Gateway) or `openrouter` |
| `AGENT_MODEL` | Provider model id, e.g. `anthropic/claude-sonnet-5-5`. Required, no default |
| `AI_GATEWAY_API_KEY` / `OPENROUTER_API_KEY` | Key of the selected provider |
| `AGENT_MAX_STEPS` | Model calls per chat turn, default `6` (1-10). The last one can't call tools |
| `AGENT_MAX_OUTPUT_TOKENS` | Output cap per model call, default `1024` |
| `AGENT_TURN_TIMEOUT_SECONDS` | Whole-turn timeout, default `45` |
| `AGENT_RATE_LIMIT_TURNS` / `AGENT_RATE_LIMIT_WINDOW_MINUTES` | Chat turns per user per window, default `20` / `10` |
| `DEFAULT_TIMEZONE` | IANA zone for "today" and default report months, default `Africa/Luanda` |

## Local dev

```bash
cp apps/agent/.env.example apps/agent/.env   # TELEGRAM_MODE=polling, fill the token and service key
bun run dev:agent
```

Polling calls `deleteWebhook` first (pending updates are kept), so don't point a dev bot at a production webhook. Use a separate bot for dev.

## Webhook

`POST /webhooks/telegram`. Requests without the right `X-Telegram-Bot-Api-Secret-Token` get 401. An update gets 200 only once it is stored (claimed) or needs nothing; a full queue, a failed claim, boot recovery or shutdown get 503, so Telegram redelivers it later. Registering the webhook and exposing the port are deploy setup: see [`docs/deploy-agent.md`](../../docs/deploy-agent.md).

```bash
# needs TELEGRAM_BOT_TOKEN, AGENT_PUBLIC_URL (https origin, no path), TELEGRAM_WEBHOOK_SECRET for set; DROP_PENDING_UPDATES=1 optional
bun run telegram:webhook:set    # setWebhook: <AGENT_PUBLIC_URL>/webhooks/telegram, secret_token, allowed_updates message + callback_query
bun run telegram:webhook:info   # status, never prints token or secret
bun run telegram:webhook:delete
```

`GET /health` returns `{ ok, uptime, mode, accepting, financeApi, queued }`. `accepting` is false during boot recovery and shutdown. `financeApi` is an unauthenticated probe of the API base, cached 15s.

## How an update flows

1. Adapter parses it into a channel-agnostic `InboundEvent` (`src/channels/channel.ts`). Only `src/channels/telegram/` knows grammY. Group messages other than commands are dropped here, before anything is stored.
2. A slot in the chat's serial queue is reserved (bounded: 20 per chat, 1000 total, 32 running at once), then `agentEvents.claim` stores it (duplicate: acknowledged and dropped; an ambiguous failure is retried). The stored payload keeps only what parsing needs (no names, no quoted messages).
3. Chats run concurrently; a chat's messages run in order: `updateStatus processing` → handle → `done` / `failed` (with a "something went wrong" reply). Status updates are bookkeeping and never block handling; a final status that still fails after 3 tries leaves the event to the next boot's recovery.
4. Handle: `/start <code>` redeems; anything else calls `resolve` (with `chatId`) for a 15-minute user token; group chats only get "use a private chat".
5. Commands: user and bot messages are appended to the current session (`/unlink` and `/forget` record nothing). Plain text goes to the agent (below).

Polling (dev only) takes one update at a time and moves its offset past an update only once it is stored.

**Boot:** before any intake, `listRecoverable` re-processes events a dead process left unfinished, sorted per chat by arrival (`InboundEvent.sequence`, Telegram's `update_id`; the backend lists by last update), and waits for them to finish. Recovered events skip the live queues (intake is closed): one at a time per chat, 4 chats at a time, paging until the list is empty or holds only events this boot already ran. Events older than `RECOVERY_MAX_AGE_SECONDS` are not replayed: they're marked `failed` (`stale`) and each private chat gets one "I restarted and missed your recent message(s). Please send it again." If the backend is unreachable, boot fails and the container restarts. **Shutdown:** SIGTERM closes intake (and stops recovery from starting more events), then waits for running recovery work and the queues, together bounded at 8s, under Docker's default 10s stop timeout.

**Known edge case (accepted):** an event that was already handled but whose final status update failed 3 times stays recoverable. If the bot restarts within `RECOVERY_MAX_AGE_SECONDS`, it is replayed: the user gets a duplicate reply, and if they sent `/forget` in between, the replayed message is recorded again in a fresh session. It needs a backend failure on the status call plus a restart inside the window; commands are read-only or idempotent, and writes (pending actions) carry idempotency keys.

Commands: `/start`, `/help`, `/balance`, `/unlink`, `/forget`. Plain text goes to the agent; photos get a "not supported yet" reply. Confirm/cancel buttons are only acknowledged. Replies over Telegram's 4096-character limit are split at line breaks.

## Chat agent

Read-only in this release. `src/core/agent.ts` runs one turn per text message:

1. Over 2000 characters, or over the per-user rate limit (in memory): a fixed reply, nothing stored, no model call.
2. Load the last 30 messages of the chat's session (trimmed to 24 KB at turn boundaries, newest turn always kept, with a cache breakpoint at its end), add the user message with a short context block (today in `DEFAULT_TIMEZONE`, base currency, display name), call the model with the read tools and `AGENT_MAX_STEPS`. The last step can't call tools, so a turn always ends with text. Typing indicator while it runs.
3. Store the turn (user, assistant tool calls, tool results, answer) in one append, then send the reply. Storing is best effort: a failure is logged and the reply still goes out. A turn that won't fit the session's 500 messages starts a new session first.
4. Model or provider error, timeout: the event fails and the user gets the generic apology. One abort signal covers the turn (history load, model calls, tool API calls), fired by the timeout, a fatal tool error or shutdown (turns still running 5s into the drain). A revoked link or Finance API rate limit inside a tool ends the turn with the same replies as commands.

**Providers.** `src/llm/` is the only place that imports a provider (`@ai-sdk/gateway`, `@openrouter/ai-sdk-provider`); the rest uses the AI SDK's `LanguageModel` (`ai`). A boundary test enforces it. The system prompt (`src/core/prompts/system.md`, bundled as text) never changes between turns and carries a cache breakpoint, so providers can cache it.

**Tools** (`src/tools/`, one file each): `list_accounts`, `list_categories`, `search_transactions` (max 20 rows), `get_transaction_summary`, `get_spending_by_category`, `get_cashflow`, `get_net_worth`, `list_goals`, `list_debts`. They call the Finance API with the user-scoped token from `resolve`, held inside the client: tokens and user ids never appear in the prompt, tool schemas or tool inputs. Results are compact JSON with amounts as `{ amount: "12.50", currency }`; every list is bounded. API errors come back as `{ error, message }` with fixed wording (`mixed_currencies` explains that reports across currencies aren't supported yet).

**History format** (`src/core/history.ts`): provider-agnostic JSON with a version field `v` (text, tool calls, JSON tool results; no provider metadata or reasoning), so switching provider keeps old history usable. Unversioned records from before the agent load as v1; newer versions are skipped; tool calls without results are dropped on load.

**Logs** per turn (`agent_turn`): provider, model, steps, input/output/cached tokens, tools called, latency. Never text.

### Eval

```bash
AGENT_MODEL=anthropic/claude-sonnet-5-5 AI_GATEWAY_API_KEY=... bun run eval   # or OPENROUTER_API_KEY (AI_PROVIDER picks when both are set)
bun run eval 3                                                                # one case
```

About 20 Portuguese and English messages against the real model, with a fake Finance API serving `test/fixtures/finance.ts`. Checks the tool(s) and key arguments, prints pass/fail and token totals. Not in CI; skipped without a key.

## Logs

JSON lines on stdout. Ids, kinds, error names/codes and timings only: never message text, link codes, tokens or keys. Fields named like `text`/`token`/`key` are redacted and the configured secrets are scrubbed from every value as a backstop.

## Docker

```bash
docker build -f apps/agent/Dockerfile -t dalva-agent .
docker run --env-file apps/agent/.env -p 8080:8080 dalva-agent
```

Production runs the GHCR image from `deploy/agent/docker-compose.yml` (see `docs/deploy-agent.md`).

Build from the repo root: the image bundles the service with `@mpf/finance-contract` into one file and runs it on distroless Bun as a non-root user.
