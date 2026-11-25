# @mpf/agent

Telegram bot for DALVA. Bun + Hono, one long-running process. Stateless: events, sessions and messages live in the backend, reached only through its tRPC API (`src/core/finance.ts`, typed from `@mpf/api`'s `AppRouter`).

## Env

Validated at boot; a bad or missing value exits with the variable names (never the values). See `.env.example`.

| Var | |
| --- | --- |
| `FINANCE_API_URL` | API origin (`apps/api`). Compose fixes it to `http://api:4000` |
| `FINANCE_API_SERVICE_KEY` | Same as the API's `FINANCE_API_SERVICE_KEY` |
| `PORT` | Default `8080` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`, default `info` |
| `SESSION_IDLE_MINUTES` | Idle time before a chat starts a new session, default `30` |
| `RECOVERY_MAX_AGE_SECONDS` | Boot recovery replays only events received within this window, default `120` |
| `AGENT_MAX_STEPS` | Model calls per chat turn, default `6` (1-10). The last one can't call tools |
| `AGENT_MAX_OUTPUT_TOKENS` | Output cap per model call, default `1024` |
| `AGENT_TURN_TIMEOUT_SECONDS` | Whole-turn timeout, default `45` |
| `AGENT_RATE_LIMIT_TURNS` / `AGENT_RATE_LIMIT_WINDOW_MINUTES` | Chat turns per user per window, default `20` / `10` |
| `DEFAULT_TIMEZONE` | IANA zone for "today" and default report months, default `Africa/Luanda` |

## Runtime settings

The bot token, webhook secret, bot username, delivery mode and the AI provider, model and key are not env. The instance owner sets them in the web app (Settings → Assistant setup); the API stores them encrypted and hands them to the agent through `instance.agentConfig` (service key only). `src/core/remote-config.ts`:

- Loads at boot, then every 15s, and on demand when a webhook arrives with an unknown secret (a bot saved a moment ago) or before any bot is set. On-demand loads are throttled to one per 2s.
- A change swaps the Telegram adapter (`src/channels/telegram/runtime.ts`: polling stops and restarts on the new bot) and the model. No restart, no redeploy.
- A failed load keeps the last config. Loaded secrets join the log scrubber.
- Delivery: `webhook` when the API's `PUBLIC_URL` is https (the API set the webhook when the bot was saved), `polling` otherwise (local dev).

Without a bot the agent boots, `/health` is `ok` with `mode: "unconfigured"`, and `/webhooks/telegram` answers 503 `telegram not configured`. Boot recovery and intake start once a bot appears. Without an AI provider, commands work and plain text gets the command list.

## Local dev

```bash
bun run setup   # apps/api/.env.local with the service key; no agent env needed
bun run dev     # or bun run dev:agent with the API already running
```

`dev:agent` runs the bot against the local `apps/api`: it takes `FINANCE_API_URL` (`http://localhost:$PORT`) and `FINANCE_API_SERVICE_KEY` from `apps/api/.env.local`. Sign up (the first user owns the instance), then set a dev bot and an AI key in Settings → Assistant setup. The local `PUBLIC_URL` is http, so the bot polls.

Polling calls `deleteWebhook` first (pending updates are kept), so don't use a production bot for dev. Use a separate bot.

## Webhook

`POST /webhooks/telegram`. Requests without the right `X-Telegram-Bot-Api-Secret-Token` get 401. An update gets 200 only once it is stored (claimed) or needs nothing; no bot yet, a full queue, a failed claim, boot recovery or shutdown get 503, so Telegram redelivers it later. Saving the bot in Settings sets the webhook (`<PUBLIC_URL>/webhooks/telegram`, a generated secret, `message` + `callback_query`); Settings also shows Telegram's `getWebhookInfo` and removes the bot. Routing the path to the agent is deploy setup: see [`docs/deploy.md`](../../docs/deploy.md).

`GET /health` returns `{ ok, uptime, mode, chat, accepting, financeApi, queued }`. `mode` is `webhook`, `polling` or `unconfigured`; `chat` whether an AI provider is set. `accepting` is false until a bot is set and boot recovery ran, and during shutdown. `financeApi` is an unauthenticated probe of the API's `/health` (up below 500), cached 15s.

## How an update flows

1. Adapter parses it into a channel-agnostic `InboundEvent` (`src/channels/channel.ts`). Only `src/channels/telegram/` knows grammY. Group messages other than commands are dropped here, before anything is stored.
2. A slot in the chat's serial queue is reserved (bounded: 20 per chat, 1000 total, 32 running at once), then `agentEvents.claim` stores it (duplicate: acknowledged and dropped; an ambiguous failure is retried). The stored payload keeps only what parsing needs (no names, no quoted messages).
3. Chats run concurrently; a chat's messages run in order: `updateStatus processing` → handle → `done` / `failed` (with a "something went wrong" reply). Status updates are bookkeeping and never block handling; a final status that still fails after 3 tries leaves the event to the next boot's recovery.
4. Handle: `/start <code>` redeems; anything else calls `resolve` (with `chatId`) for a 15-minute user token; group chats only get "use a private chat".
5. Commands: user and bot messages are appended to the current session (`/unlink` and `/forget` record nothing). Plain text goes to the agent (below).

Polling (dev only) takes one update at a time and moves its offset past an update only once it is stored.

**Boot:** before any intake, `listRecoverable` re-processes events a dead process left unfinished, sorted per chat by arrival (`InboundEvent.sequence`, Telegram's `update_id`; the backend lists by last update), and waits for them to finish. Recovered events skip the live queues (intake is closed): one at a time per chat, 4 chats at a time, paging until the list is empty or holds only events this boot already ran. Events older than `RECOVERY_MAX_AGE_SECONDS` are not replayed: they're marked `failed` (`stale`) and each private chat gets one "I restarted and missed your recent message(s). Please send it again." If the backend is unreachable, boot fails and the container restarts. **Shutdown:** SIGTERM closes intake (and stops recovery from starting more events), then waits for running recovery work and the queues, together bounded at 8s, under Docker's default 10s stop timeout.

**Known edge case (accepted):** an event that was already handled but whose final status update failed 3 times stays recoverable. If the bot restarts within `RECOVERY_MAX_AGE_SECONDS`, it is replayed: the user gets a duplicate reply, and if they sent `/forget` in between, the replayed message is recorded again in a fresh session. It needs a backend failure on the status call plus a restart inside the window; commands are read-only or idempotent, a replayed turn finds its pending action by `clientKey` instead of creating a second one, and confirmed writes carry the action id as `Idempotency-Key`.

A private text message gets a 👀 reaction (seen) and the typing indicator as soon as it is handled, before the user is resolved or the model runs. Typing repeats every 4.5s and stops right before the reply is sent (or when handling ends). A failed reaction is logged (`reaction_failed`) and ignored.

Commands: `/start`, `/help`, `/balance`, `/unlink`, `/forget`. Plain text goes to the agent; photos get a "not supported yet" reply. Button presses run or cancel a proposed change (below). Replies over Telegram's 4096-character limit are split at line breaks.

## Chat agent

`src/core/agent.ts` runs one turn per text message:

1. Over 2000 characters, or over the per-user rate limit (in memory): a fixed reply, nothing stored, no model call.
2. Load the last 30 messages of the chat's session (trimmed to 24 KB at turn boundaries, newest turn always kept, with a cache breakpoint at its end), add a context message (today in `DEFAULT_TIMEZONE`, access: read-only or may propose changes, base currency, display name) and then the user's message as its own message, call the model with the tools and `AGENT_MAX_STEPS`. The last step can't call tools, so a turn always ends with text.
3. Send the reply (a Confirm/Cancel message when the turn proposed a change), then store the turn (user, assistant tool calls, tool results, answer). Storing is best effort and bounded by shutdown, not the turn deadline: a failed or aborted store is logged, the event still completes, and only that turn's history is lost (never a second paid turn from recovery). A turn that won't fit the session's 500 messages starts a new session first.
4. Model or provider error, timeout: the event fails and the user gets the generic apology. One abort signal covers the turn (history load, model calls, tool API calls), fired by the timeout, a fatal tool error or shutdown (turns still running 5s into the drain). A revoked link or Finance API rate limit inside a tool ends the turn with the same replies as commands.

**Providers.** `src/llm/` is the only place that imports a provider (`@ai-sdk/gateway`, `@openrouter/ai-sdk-provider`); the rest uses the AI SDK's `LanguageModel` (`ai`). A boundary test enforces it. The system prompt (`src/core/prompts/system.md`, bundled as text) never changes between turns and carries a cache breakpoint, so providers can cache it.

**Read tools** (`src/tools/`, one file each): `list_accounts`, `list_categories`, `search_transactions` (max 20 rows), `get_transaction_summary`, `get_spending_by_category`, `get_cashflow`, `get_net_worth`, `list_goals`, `list_debts`. They call the Finance API with the user-scoped token from `resolve`, held inside the client: tokens and user ids never appear in the prompt, tool schemas or tool inputs. Results are compact JSON with amounts as `{ amount: "12.50", currency }`; every list is bounded. `list_debts` reports `activeSummary` (non-archived debts only) and `list_categories` flags cut subcategories. API errors come back as `{ error, message }` with fixed wording (`mixed_currencies` explains that reports across currencies aren't supported yet).

### Changes (write tools)

Offered only when the identity has `finance:write` (`resolve` scopes, checked every message); read-only chats get the read tools and a context line telling the model to explain how to allow changes.

`create_transaction` (income/expense), `update_transaction`, `delete_transaction`, `create_transfer`, `delete_transfer`, `add_goal_contribution`, `record_debt_payment`. None of them calls a write route. Each one:

1. Resolves what it needs with the user's token: the account (its currency), category/subcategory (exist, active, matching type, subcategory under its category), the current row for edits and deletes (`transactions.get`; transfer legs, goal-contribution and debt-payment rows are refused with a pointer to the right tool or the app), goal or debt.
2. Converts the model's decimal string (`"5000"`, `"12.50"`) with `parseDecimalAmount` in that currency. More decimals than the currency has, zero, signs, separators, or a currency the user named that isn't the account's fail here: no rounding, no conversion. DALVA stores every currency with 2 decimals (value × 100), so a 3-decimal amount like `12.345 KWD` is refused ("only supports 2 decimal places in DALVA for now"); `12.340` is fine. A debt payment whose principal is above the debt's remaining balance is refused with that balance.
3. Has the API check it (`agentPendingActions.check`, the operation's own schema, nothing stored), so bad input fails at proposal time (`invalid_input` with the issues), not after Confirm. Then queues it for the turn.
4. Builds the summary in code from the validated input and the looked-up names, in the language the model passes (`pt`/`en`): `Despesa · 5 000,00 AOA · Alimentação › Restaurantes · BAI Conta Ordem · hoje`. The model never writes it. What will be written is always shown in full (amounts, new values, descriptions, payees, notes); only context about an existing row is cut (names to 20 characters, then dropped) to fit the backend's 500 characters. Edits list the changes first, as `field: old → new`; old values are cut, then dropped, before anything else. When the changes alone can't fit, the proposal is refused and the model asks the user to change fewer things at once.
5. Returns `{ status: "awaiting_confirmation", summary }` (no action id) to the model.

**Several changes per message.** "Paguei 3 mil no almoço, recebi 300 mil de salário e gastei 15 mil numa festa" is three proposals in one turn, confirmed together. Each write tool call takes a slot synchronously when it starts, so parallel calls keep the model's order; a failed proposal gives its slot back; at most 10 (`too_many`). New rows (two identical expenses) are always separate changes. An existing row takes one change per message: a repeat of the same update or delete isn't queued twice, a different one is refused, so the model puts every change to a row in one call. The whole batch must fit the confirm text (4000 characters) and the stored input (`AGENT_ACTION_JSON_MAX_BYTES`), checked as each change is proposed. When the turn ends, `agentPendingActions.create` stores everything with `clientKey = <eventId>:0`: one change as its own operation, several as a `batch` (`{ items: [{ operation, input }] }`, each item checked against its operation's schema). A batch summary numbers one line per change (`1. Despesa · …`), up to 4000 characters. The reply goes out as one message: the summary in bold first (so model text can't frame it), then the model's line, then one Confirm/Cancel pair (`c:<id>` / `x:<id>`). If one of the changes needs a question (which account?), the model asks and proposes none until the user answers.

**Replays.** Boot recovery can re-run a turn that already sent its buttons. The same `clientKey` (unique per user, so a replay that lands in a newer session still matches) returns the existing action: still `pending`, the Confirm message is sent again (either copy works, the second press is a no-op); anything else (`executed`, `cancelled`, `expired`, ...), the chat gets its state and no buttons.

**Button lifecycle** (`src/core/actions.ts`). The press resolves the user from the chat it came from; the backend only finds actions of that token's user and chat identity, so a forged or replayed payload from another chat is `not_found` ("no longer available").

- Confirm: `confirm` (atomic `pending -> confirmed`) → run the stored operation with `Idempotency-Key = action.id` → `complete(executed | failed, result)` → edit the original message to `✅ Saved` / `❌ Not saved` + reason, buttons removed → answer the press.
- A batch runs its items in order, item `i` with `Idempotency-Key = <action id>:<i>`, each with the retries below; one failing doesn't stop the rest. The result keeps one outcome per item (`{ items: [{ status, error?, uncertain? }] }`, `failed` with `error: "partial"` when only some ran) and the message marks each line `✅` / `❌ (reason)` / `⚠️ (may have been saved)` under `✅ Saved`, `⚠️ Partly saved` or `❌ Not saved`. A rerun after a crash replays the items that already ran and runs the failed ones again (a refused write stores nothing on its key); since a batch changes each existing row at most once, that can't reorder two writes to one row.
- Ambiguous execution (network, timeout, abort, 5xx) is retried with the same key up to 3 times; the API replays a write it already did. Still unknown, or refused after an attempt that may have landed: `failed` with `uncertain: true`, and the user is told to check DALVA before trying again.
- A stored `failed` + `uncertain` outcome keeps its warning wherever it is shown again (a later press, a replayed turn): "This may have been saved. Check DALVA before trying again."
- `conflict` on confirm: `get`. `confirmed` (an earlier crash or lost reply): run it again with the same key and complete, but only within 6 days of the confirm (the API keeps idempotency keys 7 days); later it's completed as `failed` + `uncertain`. `executed` / `failed` / `cancelled` / `expired`: edit the message to say so. A double press never runs twice.
- `forbidden` (read-only switched on since the proposal): "this chat is read-only now"; the action stays pending and expires.
- Cancel: `cancel` → "Cancelled", buttons removed; on `conflict` the current state.
- Each outcome is appended to the session as an assistant note (`[Confirm button] ✅ Saved …`), so the model knows on the next turn.
- The message ref is the callback's own message (kept in the stored payload), so edits survive restarts; when an edit fails, the result is sent as a new message.

Execution isn't bound to the turn timeout or the shutdown signal: once confirmed, it runs to an outcome under the client's per-request timeout.

**History format** (`src/core/history.ts`): provider-agnostic JSON with a version field `v` (text, tool calls, JSON tool results; no provider metadata or reasoning), so switching provider keeps old history usable. Unversioned records from before the agent load as v1; newer versions are skipped; tool calls without results are dropped on load.

**Logs** per turn (`agent_turn`): provider, model, steps, input/output/cached tokens, tools called, latency. Never text.

### Eval

```bash
AGENT_MODEL=vendor/model AI_GATEWAY_API_KEY=... bun run eval   # or OPENROUTER_API_KEY (AI_PROVIDER picks when both are set)
bun run eval 3                                                                # one case
```

About 35 Portuguese and English messages against the real model, with a fake Finance API serving `test/fixtures/finance.ts`: reads, 10 single writes (expense, salary, transfer, delete after a search, edit, goal, debt payment, an ambiguous account that must be asked about, a cross-currency transfer that must be refused), several changes in one message (three transactions, two expenses, a transfer plus a debt payment: all behind one Confirm; one with a missing account: ask, propose none) and a read-only chat. Checks the tool(s) and key arguments, whether a change is left waiting for confirmation and how many changes it holds, that no turn writes, and prints pass/fail and token totals. Not in CI; skipped without a key. The eval reads its model from env, not from the instance settings.

## Logs

JSON lines on stdout. Ids, kinds, error names/codes and timings only: never message text, link codes, tokens or keys. Fields named like `text`/`token`/`key` are redacted, and the service key and every secret of the loaded runtime settings are scrubbed from every value as a backstop.

## Docker

```bash
docker build -f apps/agent/Dockerfile -t dalva-agent .
docker run -e FINANCE_API_URL=http://host.docker.internal:4000 -e FINANCE_API_SERVICE_KEY=... -p 8080:8080 dalva-agent
```

Production runs the GHCR image in the compose stack, `deploy/docker-compose.yml` (see `docs/deploy.md`).

Build from the repo root: the image bundles the service with `@mpf/shared` into one file (only types come from `@mpf/api`) and runs it on distroless Bun as a non-root user.
