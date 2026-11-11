# Finance API v1 (Convex)

Server side of `@mpf/finance-contract`, mounted at `/api/v1/*` on the Convex site URL. One `httpAction` (`router.ts`) matches requests with the contract's `matchRoute`, validates them with the contract schemas and calls one internal query (GET) or mutation (writes) per operation (`registry.ts`). Domain logic stays in `convex/domain/*`.

## Config

- `FINANCE_API_TOKEN_SECRET`: Convex env var, at least 32 bytes. Missing or short: every request returns `internal`, `mintUserToken` throws.

## Auth

- `Authorization: Bearer <JWT>`, HS256 only, verified with Web Crypto. Claims: `sub` (userId), `scope` (`finance:read` / `finance:write`, space-separated), `aud: "finance-api"`, `exp`, `iat`.
- GET needs `finance:read`, writes need `finance:write`. Bad, forged or expired token: `unauthorized`. Missing scope: `forbidden`.
- `mintUserToken(userId, scopes, ttlSeconds)` in `tokens.ts` issues tokens server-side (TTL up to one year).

## Writes

- `Idempotency-Key` required. `(userId, key) -> sha256(operation + canonical input) + response` is stored in `apiIdempotencyKeys` inside the write's own mutation. Same key + same request: stored response, `Idempotent-Replayed: true`. Same key + different request: `conflict`. Failed writes store nothing.
- Daily cron purges keys older than 7 days.
- Writes return the re-read entity.

## Money

- The app stores every currency as value × 100. `money.ts` converts to and from ISO 4217 minor units: exact for 2-decimal currencies, round half away from zero when scaling down (JPY out, KWD in).
- Account data uses the account currency; goals, debts and reports use `userProfiles.baseCurrency` (no profile: `conflict`). Request currency must match; cross-currency transfers are rejected.
- Reports sum across accounts without FX, as the domain does.

## Managed rows

Transfer legs, goal-contribution transfers and debt-payment transactions show up in search, but `transactions.update` / `transactions.delete` return `conflict`. `transfers.*` on a goal-contribution transfer also returns `conflict`.

## `transactions.search`

- Newest first (`date`, then creation order). Keyset cursor over the most selective index: account > category > type > user, date range always in the index range.
- `q`: case-insensitive substring of description, note or payee, checked on scanned rows.
- Each page reads at most 1000 rows. Sparse filters or `q` can return a short or empty page with a non-null `nextCursor`; keep paging until it is null. No full-text index: it would order by relevance, not date, and cover one field.

## Tests

`convex/api/v1/*.test.ts` drive the API through the contract's typed client over `t.fetch`, so every success response is parsed with the contract schema. `vitest.config.ts` rewrites convex-test ids (`1;table` -> `1-table`) to be URL-safe like real Convex ids.
