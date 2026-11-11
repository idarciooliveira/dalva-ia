# Finance API v1 (Convex)

Server side of `@mpf/finance-contract`, mounted at `/api/v1/*` on the Convex site URL. One `httpAction` (`router.ts`) matches requests with the contract's `matchRoute`, validates them with the contract schemas and calls one internal query (GET) or mutation (writes) per operation (`registry.ts`). Domain logic stays in `convex/domain/*`.

## Config

- `FINANCE_API_TOKEN_SECRET`: Convex env var, at least 32 bytes. Missing or short: every request returns `internal`, `mintUserToken` throws.
- `FINANCE_API_SERVICE_KEY`: Convex env var, at least 32 bytes and different from the token secret. Used by the chat agent on service routes. Missing, short or equal to the secret: service routes return `internal`.

## Auth

- `Authorization: Bearer <JWT>`, HS256 only, verified with Web Crypto. Claims: `sub` (userId), `scope` (`finance:read` / `finance:write` / `agent:state`, space-separated), `aud: "finance-api"`, `exp`, `iat`.
- Finance routes: GET needs `finance:read`, writes need `finance:write`. Agent-store routes (below) need `agent:state` and nothing else; the finance scopes don't open them and `agent:state` doesn't open finance routes. Bad, forged or expired token: `unauthorized`. Missing scope: `forbidden`.
- `mintUserToken(userId, scopes, ttlSeconds)` in `tokens.ts` issues tokens server-side (TTL up to one year).

## Service routes (channel linking)

- `POST /channel-links/redeem`, `POST /channel-identities/resolve`, `POST /channel-identities/unlink`, plus the inbound event routes under `/agent/events/*` (see Agent store). `Authorization: Bearer <FINANCE_API_SERVICE_KEY>`, compared in constant time (both sides SHA-256'd first). User tokens get `unauthorized` here; the service key gets `unauthorized` on user routes. No scopes, no `Idempotency-Key`.
- Handlers live in `serviceRegistry.ts` and run in the httpAction (hashing, token minting), each calling one internal function in `channels.ts`. No handler takes a userId: it comes from the code row or the linked identity.
- Link codes: 32 random bytes as base64url (43 chars), created by the web action `channelLinks.createLinkCode` (needs `consent: true`), TTL 10 minutes, one pending code per user and channel. Only the SHA-256 is stored. Unknown, used, expired and superseded codes all return the same `not_found`.
- Telegram codes must be redeemed from the private chat (`chatId === externalUserId`), else `validation_failed`, so the bot is never linked into a group.
- One active identity per `(channel, externalUserId)` and per `(user, channel)`; violations return `conflict` and leave the code unused. Redeem is not retry-safe: after an ambiguous failure, call `resolve`. Checks and writes run in one mutation, so concurrent redeems serialize.
- `resolve` only answers for the chat the identity was linked from (`not_found` otherwise, e.g. in a group). It mints a 15-minute user token with the identity's scopes and a `cid` claim. Every user-route request with `cid` re-checks the identity in the same transaction: unlinked returns `unauthorized`, read-only blocks writes with `forbidden`. Turning read-only off only helps tokens minted afterwards (the token's own scopes still apply), so the agent should resolve on every message.
- Hourly cron deletes expired codes.
- `resolve` always adds `agent:state` to the token scopes (`scopes` in the response), also for read-only identities, so the bot keeps its conversation state. `identity.scopes` stays the stored finance scopes.
- Unlinking (web or `channel-identities/unlink`) deletes the identity's sessions, messages and pending actions.

## Agent store

State for the stateless chat agent (`agent.ts`, `agentEvents.ts`, domain in `domain/agentStore.ts`, crons and the web delete in `../../agentStore.ts`).

**Events (service key)** run before identity resolution, so they know no user:

- `POST /agent/events/claim {channel, eventId, payload}` -> `{status: "new" | "duplicate"}`. Dedupe key is `(channel, eventId)`. `payload` is a JSON string, at most 32 KB (UTF-8).
- `POST /agent/events/status {channel, eventId, status: processing | done | failed, error?}`. `processing` counts an attempt. `done` and `failed` are final (`conflict` after) and drop the payload. Unknown event: `not_found`.
- `GET /agent/events/recoverable?channel&olderThanSeconds=60&maxAttempts=3&limit=20`: `received`/`processing` events with no update for that long and `attempts < maxAttempts`, oldest first, with their payload. Reads at most 100 rows per status; events untouched for 24h are deleted, so the head of the queue can't stay blocked.

**Sessions, messages, pending actions, history (user token, `agent:state`)**. The token must carry `cid` (a resolved channel token): without it `forbidden`; once the identity is unlinked `unauthorized`. `userId` and the identity come from the token. Every id in a request is checked against the token's user and identity: someone else's session or action is `not_found`. No `Idempotency-Key`.

- `POST /agent/sessions/current {channel, chatId, idleTimeoutMinutes, startNew?}`: the active session of the chat, or a new one when it was idle longer than the timeout (the old one is ended) or `startNew`. `channel`/`chatId` must be the chat the token was resolved for (`validation_failed` otherwise).
- `GET /agent/sessions/:sessionId/messages?limit` (default 50, max 200): latest N, oldest first. `POST` same path `{messages: [{role, content}]}` (1-20, `content` is a JSON string up to 32 KB): stored in order with a per-session `seq`, bumps `lastActivityAt`. Past 500 messages per session, or on an ended session: `conflict`, nothing stored; call `current` with `startNew: true`.
- `POST /agent/pending-actions {sessionId, operation, input, summary, ttlSeconds?, clientKey?}`: `operation` is a finance write (`transactions.create`, ...), `input` is validated against that operation's request schema. TTL default 10 minutes, max 1 hour. At most 20 live pending actions per session (expired rows are swept as they are read). `create` and `confirm` need an identity that still has `finance:write` (`forbidden` for a read-only one, and the action stays `pending`); `cancel` does not. `input` and `result` are free-form JSON: keys that are empty, start with `$`/`_`, aren't printable ASCII or are longer than 1024 characters, and nesting past 12 levels, are `validation_failed` (Convex can't store them). Every request body is capped at 64 KiB, so a batch of large messages must be split across `append` calls.
- `clientKey` (`[A-Za-z0-9:_-]{1,128}`, optional) makes `create` idempotent per session: a second create with the same key in the same session returns the stored action in whatever status it has now (its input and summary, not the new ones), stores nothing, and skips the ended-session and per-session limit checks. It still needs `finance:write`. The agent uses `<eventId>:0`, so a turn replayed by boot recovery finds its action instead of proposing again.
- `GET /agent/pending-actions/:id`. `POST .../confirm`: atomic `pending -> confirmed`, returns the stored operation and input. `conflict` when not pending or expired; an expired action is committed as `expired` first. `POST .../cancel`: only `pending`, else `conflict`. `POST .../complete {status: executed | failed, result}`: only `confirmed`, else `conflict`.
- `DELETE /agent/history`: the user's sessions, messages and pending actions, every channel. The user's active sessions are ended at once (so they take no new messages or actions, and `current` starts a fresh session), the first 500 rows are deleted now and the rest through the scheduler. The batches only delete history created before the request, so what the user does afterwards is never touched. Unlink works the same way for the identity's history.

History deletion removes `confirmed` actions too. If the user deletes their history while the agent is executing one, the finance call still runs (the user pressed Confirm) and `complete` returns `not_found`: drop the result.

Why `confirm` is not idempotent: a second call is a `conflict` by design (it is the double-execution guard). After an ambiguous failure, `get` the action: `confirmed` means go on and execute with the action id as `Idempotency-Key` (finance routes replay a stored response for the same key), then `complete`. A crash after `confirm` is recovered the same way: the button press is an inbound event whose payload carries the action id, so re-processing it hits `confirm` -> `conflict` -> `get` -> execute -> `complete`. `confirmed` actions never expire on their own; the 30-day purge removes them.

**Retention (crons)**: inbound events are deleted 24h after their last update (done, failed or abandoned; the payload is already dropped when finished); pending actions past `expiresAt` become `expired` (every 15 minutes; `confirm` checks the time itself); sessions with no activity for 30 days are deleted with their messages and actions, and so are finished actions of that age (daily). Every job is bounded (200 rows, 500 for history) and reschedules itself while full.

## Writes

- Bodies are capped at 64 KiB: `Content-Length` is checked first, then the stream is read and cancelled once it passes the cap.
- `Idempotency-Key` required. `(userId, key) -> sha256(operation + canonical input) + response` is stored in `apiIdempotencyKeys` inside the write's own mutation. Same key + same request: stored response, `Idempotent-Replayed: true`. Same key + different request: `conflict`. Failed writes store nothing.
- Daily cron purges keys older than 7 days.
- Writes return the re-read entity.

## Money

- The app stores every currency as value × 100. `money.ts` converts to and from ISO 4217 minor units: exact for 2-decimal currencies, round half away from zero when scaling down (JPY out, KWD in).
- Account data uses the account currency; goals, debts and reports use `userProfiles.baseCurrency` (no profile: `conflict`). Request currency must match; cross-currency transfers are rejected.
- No FX: a report that would sum amounts outside the base currency returns `conflict` with `details: { reason: "mixed_currencies", currencies }`.
- Rows left behind by a deleted account have no known currency: reports that would sum them return `conflict` with `details: { reason: "unknown_currency" }`. Listings still label such rows with the base currency.

## Managed rows

Transfer legs, goal-contribution transfers and debt-payment transactions show up in search, but `transactions.update` / `transactions.delete` return `conflict`. `GET /transactions/:id` returns one row with `managedBy: transfer | goal_contribution | debt_payment` for those, so a client can tell before trying. `transfers.*` on a goal-contribution transfer also returns `conflict`.

## `transactions.search`

- Newest first (`date`, then creation order). Keyset cursor (rows tied on creation time are tracked by id) over the most selective index: account > category > type > user, date range always in the index range.
- `q`: case-insensitive substring of description, note or payee, checked on scanned rows.
- Each page reads at most 1000 rows. Sparse filters or `q` can return a short or empty page with a non-null `nextCursor`; keep paging until it is null. No full-text index: it would order by relevance, not date, and cover one field.

## Tests

`convex/api/v1/*.test.ts` drive the API through the contract's typed client over `t.fetch`, so every success response is parsed with the contract schema. `vitest.config.ts` rewrites convex-test ids (`1;table` -> `1-table`) to be URL-safe like real Convex ids.
