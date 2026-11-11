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

`POST /webhooks/telegram`. Requests without the right `X-Telegram-Bot-Api-Secret-Token` get 401. Valid updates get 200 at once and are processed in the background; 503 while booting or when the queue is full, so Telegram retries. Registering the webhook and exposing the port are part of the deploy setup.

`GET /health` returns `{ ok, uptime, mode, ready, financeApi, queued }`. `financeApi` is an unauthenticated probe of the API base, cached 15s.

## How an update flows

1. Adapter parses it into a channel-agnostic `InboundEvent` (`src/channels/channel.ts`). Only `src/channels/telegram/` knows grammY. Group messages other than commands are dropped here, before anything is stored.
2. Per-chat serial queue (bounded: 20 per chat, 1000 total, 32 running at once). Chats run concurrently; a chat's messages run in order. Polling never fetches more than the queue can take.
3. `agentEvents.claim` (duplicate: drop) → `updateStatus processing` → handle → `done` / `failed`.
4. Handle: `/start <code>` redeems; anything else calls `resolve` (with `chatId`) for a 15-minute user token; group chats only get "use a private chat".
5. User and bot messages are appended to the current session (`/unlink` and `/forget` record nothing).

On boot, `listRecoverable` re-queues events a crashed run left unfinished before the webhook opens; every 60s it picks up events whose status update failed (untouched for 2 minutes, not queued in this process). SIGTERM stops intake and drains the queues for 8s, under Docker's default 10s stop timeout.

Commands: `/start`, `/help`, `/balance`, `/unlink`, `/forget`. Other text and photos get a "coming soon" reply. Confirm/cancel buttons are only acknowledged.

## Logs

JSON lines on stdout. Ids, kinds, error names/codes and timings only: never message text, link codes, tokens or keys. Fields named like `text`/`token`/`key` are redacted and the configured secrets are scrubbed from every value as a backstop.

## Docker

```bash
docker build -f apps/agent/Dockerfile -t dalva-agent .
docker run --env-file apps/agent/.env -p 8080:8080 dalva-agent
```

Build from the repo root: the image bundles the service with `@mpf/finance-contract` into one file and runs it on distroless Bun as a non-root user.
