# Finance API v1 (Convex)

Server side of `@mpf/finance-contract`, mounted at `/api/v1/*` on the Convex site URL. One `httpAction` (`router.ts`) matches requests with the contract's `matchRoute`, validates them with the contract schemas and calls one internal query (GET) or mutation (writes) per operation (`registry.ts`). Domain logic stays in `convex/domain/*`.

## Config

- `FINANCE_API_TOKEN_SECRET`: Convex env var, at least 32 bytes. Missing or short: every request returns `internal`, `mintUserToken` throws.
- `FINANCE_API_SERVICE_KEY`: Convex env var, at least 32 bytes and different from the token secret. Used by the chat agent on service routes. Missing, short or equal to the secret: service routes return `internal`.

## Auth

- `Authorization: Bearer <JWT>`, HS256 only, verified with Web Crypto. Claims: `sub` (userId), `scope` (`finance:read` / `finance:write`, space-separated), `aud: "finance-api"`, `exp`, `iat`.
- GET needs `finance:read`, writes need `finance:write`. Bad, forged or expired token: `unauthorized`. Missing scope: `forbidden`.
- `mintUserToken(userId, scopes, ttlSeconds)` in `tokens.ts` issues tokens server-side (TTL up to one year).

## Service routes (channel linking)

- `POST /channel-links/redeem`, `POST /channel-identities/resolve`, `POST /channel-identities/unlink`. `Authorization: Bearer <FINANCE_API_SERVICE_KEY>`, compared in constant time (both sides SHA-256'd first). User tokens get `unauthorized` here; the service key gets `unauthorized` on user routes. No scopes, no `Idempotency-Key`.
- Handlers live in `serviceRegistry.ts` and run in the httpAction (hashing, token minting), each calling one internal function in `channels.ts`. No handler takes a userId: it comes from the code row or the linked identity.
- Link codes: 32 random bytes as base64url (43 chars), created by the web action `channelLinks.createLinkCode` (needs `consent: true`), TTL 10 minutes, one pending code per user and channel. Only the SHA-256 is stored. Unknown, used, expired and superseded codes all return the same `not_found`.
- One active identity per `(channel, externalUserId)` and per `(user, channel)`; violations return `conflict` and leave the code unused. Checks and writes run in one mutation, so concurrent redeems serialize.
- `resolve` only answers for the chat the identity was linked from (`not_found` otherwise, e.g. in a group). It mints a 15-minute user token with the identity's scopes and a `cid` claim. Every user-route request with `cid` re-checks the identity in the same transaction: unlinked returns `unauthorized`, read-only blocks writes with `forbidden`.
- Hourly cron deletes expired codes.

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

Transfer legs, goal-contribution transfers and debt-payment transactions show up in search, but `transactions.update` / `transactions.delete` return `conflict`. `transfers.*` on a goal-contribution transfer also returns `conflict`.

## `transactions.search`

- Newest first (`date`, then creation order). Keyset cursor (rows tied on creation time are tracked by id) over the most selective index: account > category > type > user, date range always in the index range.
- `q`: case-insensitive substring of description, note or payee, checked on scanned rows.
- Each page reads at most 1000 rows. Sparse filters or `q` can return a short or empty page with a non-null `nextCursor`; keep paging until it is null. No full-text index: it would order by relevance, not date, and cover one field.

## Tests

`convex/api/v1/*.test.ts` drive the API through the contract's typed client over `t.fetch`, so every success response is parsed with the contract schema. `vitest.config.ts` rewrites convex-test ids (`1;table` -> `1-table`) to be URL-safe like real Convex ids.
