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

- service key (`src/auth/service-key.ts`, config `FINANCE_API_SERVICE_KEY`): the chat agent's own credential for the service routes, compared in constant time. Goes first, since it is a bearer credential too; any other bearer value falls through to the user-token source. Unset (allowed outside production): service routes answer 401.
- bearer user token (`src/auth/tokens.ts`): HS256 JWT with `sub`, `scope`, `aud: "finance-api"`, `exp` and, for a linked chat, `cid`. Same format and secret variable (`FINANCE_API_TOKEN_SECRET`) as the Convex backend, so the agent works with either; ids differ, so a token only works on the backend that minted it (the agent resolves one per message). The user isn't looked up: tokens are only minted for existing users, and users are never deleted. A `cid` token is re-checked against its channel identity inside each request's transaction: unlinked is `unauthorized`, read-only blocks writes with `forbidden`.
- session cookie: full finance access (`finance:read`, `finance:write`). Never tried when the request has an `Authorization` header.

Invalid credentials answer `unauthorized` (with `WWW-Authenticate: Bearer`), a missing scope `forbidden`.

Password hashes from Convex Auth (Lucia `Scrypt`) use the same format as Better Auth's and verify as they are, so imported users keep their passwords.

## Schema and migrations

- `src/db/schema.ts` is the source of truth. After changing it, run `bun run db:generate` and commit the new file in `drizzle/`. CI fails when the schema and the migrations disagree.
- Hand-written SQL (anything Drizzle can't express): `bunx drizzle-kit generate --custom --name <what>` in `apps/api`, then fill the empty file.
- Conventions are in the header of `schema.ts`: UUIDv7 ids from Postgres, `user_id` on every user-owned row, money as `bigint` minor units, `date` for calendar dates, enums for closed sets, deferred foreign keys.

## Convex import

`bun run migrate:convex <export.zip> [--dry-run] [--drop-invalid]` (`scripts/migrate-from-convex.ts`, logic in `src/import/`) loads a `npx convex export` into an empty, migrated database in one transaction and verifies it. Rules, report and the cutover runbook: `docs/deploy.md`, "Cutover".

## Contract routes (`/api/v1`)

`src/http/router.ts` serves every route of `@mpf/finance-contract` with the Convex router's semantics: credential of the route's kind (401) → implemented (404) → scope (403) → `Idempotency-Key` on finance writes (400) → body (JSON object, 64 KiB cap, read as a stream) and the route's request schema (400) → handler → `{ ok: true, data }`. A credential that is present but invalid is refused by the principal middleware first, on any `/api/v1` path; paths that match no contract route fall through to the app's 404. Responses carry `Cache-Control: no-store`.

Web-only routes (`webOnly` in the contract: profile, account and category management, chat links, `transfers.get`) answer `forbidden` to chat tokens (`cid`), so the agent can't reach them. Routes marked `idempotent: false` (the chat-link writes) take no `Idempotency-Key`: a stored replay of `chatLinks.createCode` would keep the raw link code.

Agent-store routes (explicit `scope: agent:state`) require a chat token whose identity is still linked, take no `Idempotency-Key`, and a handler may return `commitThenFail(error)` to commit its writes and still answer with an error (an action marked `expired` on confirm; Convex's `handlerFailure`). On a route with an `Idempotency-Key` that is a 500: the replay would be a stored success.

Service routes (`auth: "service"`: channel link redeem, identity resolve and unlink, inbound events) take the service key only: credential (401) → implemented (404) → body and schema (400) → handler in a transaction. They act for no user; each handler finds the user from server state (the code row, the linked identity). Implementations: `src/http/v1/service.ts`, registered in `serviceOperations`.

Layout, per contract group (copy it for the next one):

```text
src/domain/<group>.ts        Domain logic: (tx, userId, args), Drizzle queries, throws DomainError
src/domain/<group>.test.ts   Domain tests against the database
src/http/v1/<group>.ts       One operation per contract route: contract input -> domain -> DTO
src/http/v1/<group>.test.ts  HTTP tests through the contract client
src/http/v1/index.ts         Registry: add the group here (`operations`, or `serviceOperations` for service routes)
```

- An operation is `operation(routes.group.op, async (tx, user, input) => response)`. `input` is already validated; `user.userId` is the only user id there is (never take one from `input`). The registry type requires every operation of a group once the group is there; groups not ported yet answer `not_found`.
- GET runs in a read-only snapshot (`readTx`), writes in `withTx`, with the idempotency record in the same transaction.
- Errors: throw `DomainError` (`notFound("Account")`, `conflict(...)`, `invalid(path, message)` in `src/domain/errors.ts`); the router sends its code, status and details. Anything else is a logged 500 with no detail.
- Ids: contract ids are any URL-safe string, rows are lowercase UUIDs. `toId(input.id, "id")` turns anything else into `validation_failed` (as Convex's `normalizeId`); missing and other users' rows are both `not_found`.
- Money: the database stores value × 100 for every currency (as Convex did); `src/domain/money.ts` converts to and from ISO minor units. Request amounts that don't fit exactly are `validation_failed` (`reason: "precision"`), never rounded.
- DTOs (`src/http/v1/shared.ts`): optional fields are omitted, never null; `archived` only appears when true.

Transactions, transfers and reports (`src/domain/{transactions,transfers,reports}.ts`):

- Every transaction write moves the account balance in the same transaction (`addToBalances`: `balance = balance + delta`, accounts in id order). Concurrent writes to one account collide under SERIALIZABLE and `withTx` reruns the loser, so no delta is lost.
- A transfer is two `transfer` rows sharing `transfer_group_id`, linked to each other; either leg's id addresses it. Transfer legs and debt-payment rows answer `conflict` on `transactions.update`/`delete`; goal-contribution transfers answer `conflict` on `transfers.update`/`delete`.
- Legacy rows with a null `account_id` (Convex deleted the account) skip their balance effect, list in the base currency with `accountId: MISSING_ACCOUNT_ID` (a nil UUID no lookup finds, as Convex's dangling id), and make a report that would sum them `conflict` (`unknown_currency`).
- `transactions.search`: keyset cursor over `(date, created_at, id)`, `created_at` in microseconds (a JS Date would lose them). All filters, `q` included, run in SQL, so only the last page is short.
- Reports: a month is `[first day, first day of next month)`, never a `-31` bound. Totals use SQL aggregates over every row of the range.
- A date the contract accepts but Postgres can't hold (year 0000) is `validation_failed` (router, SQLSTATE 22008); a stored amount or total the contract can't express is `conflict` (`MoneyRangeError`).

Goals and debts (`src/domain/{goals,debts}.ts`), in the base currency like Convex:

- A contribution to an account-linked goal is a transfer into the linked account (`createTransfer`); removing the contribution deletes it (`deleteTransferLegs`). A contribution whose transfer is gone (`transaction_id` nulled) only moves `current_amount` on removal. Deleting a goal keeps its transfers as plain transfers.
- A debt payment is an expense on the paying account plus, for a linked debt, an adjustment of minus the principal on the linked account (`createTransaction`). Removing it, or deleting the debt, deletes those rows and reverses their balances (`deleteTransactionRows`). Legacy payments with a null `from_account_id` or `source_transaction_id` list with the nil-UUID placeholders (`MISSING_ACCOUNT_ID`, `MISSING_TRANSACTION_ID`) and skip what is gone on removal.
- `current_amount` and `current_balance` move with relative updates; the principal check reads the balance in the same SERIALIZABLE transaction, so racing payments can't pay down more than is left.
- A goal's or debt's linked account, and the accounts a contribution or payment moves money on, must be in the base currency (`validation_failed`).

Tests use `test/api.ts`: `seedUser`, `seedAccount`, `seedCategory`, `seedSubcategory`, `seedTransaction` (rows only, no balance; `null` account for legacy rows), `seedDebt`, `seedDebtPayment`, `seedContribution`, `seedChannelIdentity`, `tokenFor(userId, scopes?)`, `clientFor(app, token)` (the contract client, which parses every success with the response schema), `serviceClientFor(app)` (service key), `linkedChat(app)` (a user linked through the real code/redeem/resolve flow, with its agent token), `raw(app, method, path, { token | cookie, body, idempotencyKey })`, `expectApiError(promise, code, status)` and `twoUsers()` for isolation checks. `testApp({ operations })` swaps in fake operations (e.g. one that writes then throws).

## Idempotency

Finance writes need `Idempotency-Key` (8-128 of `[A-Za-z0-9._:-]`). `(user, key) -> sha256(operation + canonical input) + response` is stored in `api_idempotency_keys` inside the write's transaction (`src/http/idempotency.ts`). Same key and request: the stored response, `Idempotent-Replayed: true`. Same key, different request or operation: `conflict`. A failed write stores nothing. Concurrent requests with one key serialize: one runs, the others replay it. The key is claimed with `INSERT ... ON CONFLICT DO NOTHING` and the row is only read when the key exists: a `SELECT` under SERIALIZABLE takes index-page read locks, and with clustered UUIDv7 ids every user's write then collided with every other's (about one 500 in ten at 40 concurrent writers). Keep reads of shared, append-heavy tables off the hot write path for the same reason. Keys count as unused after 7 days; `purgeExpiredIdempotencyKeys` deletes them in batches (a retention job).

## Agent store and retention jobs

The chat agent keeps no state of its own: inbound events (dedupe and crash recovery), sessions, messages and pending actions live in the `agent_*` tables (`src/domain/agentStore.ts`). They are ephemeral and never migrated from Convex. Their keys are composite `(x_id, user_id)` like the domain keys, but immediate and `ON DELETE CASCADE`: deleting a session deletes its messages and actions. Unlink and "delete history" delete in one statement, in the request's transaction (Convex batched them through the scheduler).

`src/jobs/retention.ts` runs the Convex crons in-process with croner (UTC): idempotency keys (daily), expired link codes (hourly), inbound events 24 h after their last update (hourly), pending actions past `expiresAt` → `expired` (every 15 min), sessions inactive for 30 days and actions of that age (daily). Each step is one autocommitted statement per batch, repeated until a batch comes back short; it repeats its condition on the rows it changes, so a row a request touched meanwhile is left alone. A job runs on one reserved connection that holds a Postgres advisory lock (`pg_try_advisory_lock`) for the run and unlocks it before going back to the pool, so with several API instances only one runs a given job; the others log `job_skipped`. Shutdown stops scheduling, lets runs in progress finish their current batch and waits for them.

## Writes

Every write goes through `withTx(db, async (tx) => ...)` (`src/db/tx.ts`): one `SERIALIZABLE` transaction, rerun on serialization failure (`40001`) or deadlock (`40P01`), up to 10 attempts with jittered backoff capped at 250 ms per retry. The callback can run more than once, so it must not have side effects outside the database.

## Tests

```bash
bun run --filter '@mpf/api' test:once   # or: cd apps/api && bunx vitest
```

Tests need Postgres: the compose server, or any server in `TEST_DATABASE_URL` where the suite may create and drop `dalva_test_*` databases. Each run migrates a template database; each Vitest worker clones its own database from it; every table is truncated before each test. Call the app in-process with `testApp().app.request(...)` (`test/app.ts`), or through the helpers in `test/api.ts` (see Contract routes).
