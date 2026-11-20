# @mpf/api

DALVA's own backend, replacing Convex: Bun + Hono + Postgres + Drizzle. Not deployed yet; production stays on Convex until the cutover (`docs/migration-plan.md`).

## Run locally

From the repo root:

```bash
docker compose -f compose.dev.yml up -d        # Postgres 18 on 127.0.0.1:5432
cp apps/api/.env.example apps/api/.env.local   # DATABASE_URL for that server
bun run db:migrate                             # apply apps/api/drizzle/*.sql
bun run dev:api                                # http://localhost:4000/health
```

Config is validated at boot (`src/config.ts`); a bad variable is named in the error, its value never is.

## Auth

Better Auth, email and password, mounted at `/api/auth/*` (`src/auth/auth.ts`). Sessions are httpOnly, SameSite=Lax cookies (`Secure` when `PUBLIC_URL` is https) that last 30 days and renew daily while in use. Web and API share one origin behind the proxy, so auth writes posted from any other origin are refused. Rate limits on sign-in and sign-up are per client address and need `CLIENT_IP_HEADER`, a header the proxy overwrites (required in production, off locally).

Requests under `/api/v1/*` get a principal from `src/http/principal.ts`: one middleware turns the request into "who is calling, with what scopes". Sources, first match wins:

- service key (PR 8): goes first, since it is a bearer credential too.
- bearer user token (`src/auth/tokens.ts`): HS256 JWT with `sub`, `scope`, `aud: "finance-api"`, `exp` and, for a linked chat, `cid`. Same format and secret variable (`FINANCE_API_TOKEN_SECRET`) as the Convex backend, so the agent works with either; ids differ, so a token only works on the backend that minted it (the agent resolves one per message). The user isn't looked up: tokens are only minted for existing users, and users are never deleted. A `cid` token is re-checked against its channel identity inside each request's transaction: unlinked is `unauthorized`, read-only blocks writes with `forbidden`.
- session cookie: full finance access (`finance:read`, `finance:write`). Never tried when the request has an `Authorization` header.

Invalid credentials answer `unauthorized` (with `WWW-Authenticate: Bearer`), a missing scope `forbidden`.

Password hashes from Convex Auth (Lucia `Scrypt`) use the same format as Better Auth's and verify as they are, so imported users keep their passwords.

## Schema and migrations

- `src/db/schema.ts` is the source of truth. After changing it, run `bun run db:generate` and commit the new file in `drizzle/`. CI fails when the schema and the migrations disagree.
- Hand-written SQL (anything Drizzle can't express): `bunx drizzle-kit generate --custom --name <what>` in `apps/api`, then fill the empty file.
- Conventions are in the header of `schema.ts`: UUIDv7 ids from Postgres, `user_id` on every user-owned row, money as `bigint` minor units, `date` for calendar dates, enums for closed sets, deferred foreign keys.

## Contract routes (`/api/v1`)

`src/http/router.ts` serves every route of `@mpf/finance-contract` with the Convex router's semantics: credential of the route's kind (401) → implemented (404) → scope (403) → `Idempotency-Key` on finance writes (400) → body (JSON object, 64 KiB cap, read as a stream) and the route's request schema (400) → handler → `{ ok: true, data }`. A credential that is present but invalid is refused by the principal middleware first, on any `/api/v1` path; paths that match no contract route fall through to the app's 404. Responses carry `Cache-Control: no-store`.

Web-only routes (`webOnly` in the contract: profile, account management) answer `forbidden` to chat tokens (`cid`), so the agent can't reach them. Agent-store routes (explicit `scope`) require a chat token. Still to add with the agent store (PR 8): a way for a handler to commit its writes and answer with an error (Convex's `handlerFailure`).

Layout, per contract group (copy it for the next one):

```text
src/domain/<group>.ts        Domain logic: (tx, userId, args), Drizzle queries, throws DomainError
src/domain/<group>.test.ts   Domain tests against the database
src/http/v1/<group>.ts       One operation per contract route: contract input -> domain -> DTO
src/http/v1/<group>.test.ts  HTTP tests through the contract client
src/http/v1/index.ts         Registry: add the group here
```

- An operation is `operation(routes.group.op, async (tx, user, input) => response)`. `input` is already validated; `user.userId` is the only user id there is (never take one from `input`). The registry type requires every operation of a group once the group is there; groups not ported yet answer `not_found`.
- GET runs in a read-only snapshot (`readTx`), writes in `withTx`, with the idempotency record in the same transaction.
- Errors: throw `DomainError` (`notFound("Account")`, `conflict(...)`, `invalid(path, message)` in `src/domain/errors.ts`); the router sends its code, status and details. Anything else is a logged 500 with no detail.
- Ids: contract ids are any URL-safe string, rows are lowercase UUIDs. `toId(input.id, "id")` turns anything else into `validation_failed` (as Convex's `normalizeId`); missing and other users' rows are both `not_found`.
- Money: the database stores value × 100 for every currency (as Convex did); `src/http/v1/money.ts` converts to and from ISO minor units. Request amounts that don't fit exactly are `validation_failed` (`reason: "precision"`), never rounded.
- DTOs (`src/http/v1/shared.ts`): optional fields are omitted, never null; `archived` only appears when true.

Tests use `test/api.ts`: `seedUser`, `seedAccount`, `seedChannelIdentity`, `tokenFor(userId, scopes?)`, `clientFor(app, token)` (the contract client, which parses every success with the response schema), `raw(app, method, path, { token | cookie, body, idempotencyKey })`, `expectApiError(promise, code, status)` and `twoUsers()` for isolation checks. `testApp({ operations })` swaps in fake operations (e.g. one that writes then throws).

## Idempotency

Finance writes need `Idempotency-Key` (8-128 of `[A-Za-z0-9._:-]`). `(user, key) -> sha256(operation + canonical input) + response` is stored in `api_idempotency_keys` inside the write's transaction (`src/http/idempotency.ts`). Same key and request: the stored response, `Idempotent-Replayed: true`. Same key, different request or operation: `conflict`. A failed write stores nothing. Concurrent requests with one key serialize: one runs, the others replay it. The key is claimed with `INSERT ... ON CONFLICT DO NOTHING` and the row is only read when the key exists: a `SELECT` under SERIALIZABLE takes index-page read locks, and with clustered UUIDv7 ids every user's write then collided with every other's (about one 500 in ten at 40 concurrent writers). Keep reads of shared, append-heavy tables off the hot write path for the same reason. Keys count as unused after 7 days; `purgeExpiredIdempotencyKeys` deletes them in batches (scheduled with the other retention jobs in PR 8).

## Writes

Every write goes through `withTx(db, async (tx) => ...)` (`src/db/tx.ts`): one `SERIALIZABLE` transaction, rerun on serialization failure (`40001`) or deadlock (`40P01`), up to 10 attempts with jittered backoff capped at 250 ms per retry. The callback can run more than once, so it must not have side effects outside the database.

## Tests

```bash
bun run --filter '@mpf/api' test:once   # or: cd apps/api && bunx vitest
```

Tests need Postgres: the compose server, or any server in `TEST_DATABASE_URL` where the suite may create and drop `dalva_test_*` databases. Each run migrates a template database; each Vitest worker clones its own database from it; every table is truncated before each test. Call the app in-process with `testApp().app.request(...)` (`test/app.ts`), or through the helpers in `test/api.ts` (see Contract routes).
