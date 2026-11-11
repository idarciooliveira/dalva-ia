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

## Local dev

```bash
cp apps/agent/.env.example apps/agent/.env   # TELEGRAM_MODE=polling, fill the token and service key
bun run dev:agent
```

Polling calls `deleteWebhook` first (pending updates are kept), so don't point a dev bot at a production webhook. Use a separate bot for dev.

## Webhook

`POST /webhooks/telegram`. Requests without the right `X-Telegram-Bot-Api-Secret-Token` get 401. An update gets 200 only once it is stored (claimed) or needs nothing; a full queue, a failed claim, boot recovery or shutdown get 503, so Telegram redelivers it later. Registering the webhook and exposing the port are part of the deploy setup.

`GET /health` returns `{ ok, uptime, mode, accepting, financeApi, queued }`. `accepting` is false during boot recovery and shutdown. `financeApi` is an unauthenticated probe of the API base, cached 15s.

## How an update flows

1. Adapter parses it into a channel-agnostic `InboundEvent` (`src/channels/channel.ts`). Only `src/channels/telegram/` knows grammY. Group messages other than commands are dropped here, before anything is stored.
2. A slot in the chat's serial queue is reserved (bounded: 20 per chat, 1000 total, 32 running at once), then `agentEvents.claim` stores it (duplicate: acknowledged and dropped; an ambiguous failure is retried). The stored payload keeps only what parsing needs (no names, no quoted messages).
3. Chats run concurrently; a chat's messages run in order: `updateStatus processing` → handle → `done` / `failed` (with a "something went wrong" reply).
4. Handle: `/start <code>` redeems; anything else calls `resolve` (with `chatId`) for a 15-minute user token; group chats only get "use a private chat".
5. User and bot messages are appended to the current session (`/unlink` and `/forget` record nothing).

Polling (dev only) takes one update at a time and moves its offset past an update only once it is stored.

**Boot:** before any intake, `listRecoverable` re-processes events a dead process left unfinished, sorted per chat by arrival (`InboundEvent.sequence`, Telegram's `update_id`; the backend lists by last update), and waits for them to finish. A page (50) finishes before the next is read. If the backend is unreachable, boot fails and the container restarts. **Shutdown:** SIGTERM closes intake, then drains the queues for 8s, under Docker's default 10s stop timeout.

Commands: `/start`, `/help`, `/balance`, `/unlink`, `/forget`. Other text and photos get a "coming soon" reply. Confirm/cancel buttons are only acknowledged. Replies over Telegram's 4096-character limit are split at line breaks.

## Logs

JSON lines on stdout. Ids, kinds, error names/codes and timings only: never message text, link codes, tokens or keys. Fields named like `text`/`token`/`key` are redacted and the configured secrets are scrubbed from every value as a backstop.

## Docker

```bash
docker build -f apps/agent/Dockerfile -t dalva-agent .
docker run --env-file apps/agent/.env -p 8080:8080 dalva-agent
```

Build from the repo root: the image bundles the service with `@mpf/finance-contract` into one file and runs it on distroless Bun as a non-root user.
