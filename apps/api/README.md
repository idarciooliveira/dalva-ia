# @mpf/api

DALVA's backend: Bun + Hono + Postgres + Drizzle + Better Auth. Deployed with the compose stack (`docs/deploy.md`).

## Run locally

From the repo root:

```bash
bun run setup     # apps/api/.env.local with generated secrets, Postgres (compose.dev.yml), migrations
bun run dev:api   # Postgres up, migrations, then http://localhost:4000/health in watch mode
```

`bun run dev` starts the API with the web app (which proxies `/api` here) and the agent. Every variable is described in `.env.example`.

Config is validated at boot (`src/config.ts`); a bad variable is named in the error, its value never is.

## Auth

Better Auth, email and password, mounted at `/api/auth/*` (`src/auth/auth.ts`). Sessions are httpOnly, SameSite=Lax cookies (`Secure` when `PUBLIC_URL` is https) that last 30 days and renew daily while in use. Web and API share one origin behind the proxy, so auth writes posted from any other origin are refused. Rate limits on sign-in and sign-up are per client address and need `CLIENT_IP_HEADER`, a header the proxy overwrites (required in production, off locally).

Every API request gets a principal from `src/http/principal.ts` when its tRPC context is built: "who is calling, with what scopes". Sources, first match wins:

- service key (`src/auth/service-key.ts`, config `FINANCE_API_SERVICE_KEY`): the chat agent's own credential for the service procedures, compared in constant time. Goes first, since it is a bearer credential too; any other bearer value falls through to the user-token source. Unset (allowed outside production): service procedures answer 401.
- bearer user token (`src/auth/tokens.ts`): HS256 JWT with `sub`, `scope`, `aud: "finance-api"`, `exp` and, for a linked chat, `cid`. The user isn't looked up: tokens are only minted for existing users, and users are never deleted. A `cid` token is re-checked against its channel identity inside each request's transaction: unlinked is `unauthorized`, read-only blocks writes with `forbidden`.
- session cookie: full finance access (`finance:read`, `finance:write`). Never tried when the request has an `Authorization` header.

Invalid credentials answer `unauthorized` (with `WWW-Authenticate: Bearer`), a missing scope `forbidden`.

Password hashes of imported users (Lucia `Scrypt`) use the same format as Better Auth's and verify as they are.

## Schema and migrations

- `src/db/schema.ts` is the source of truth. After changing it, run `bun run db:generate` and commit the new file in `drizzle/`. CI fails when the schema and the migrations disagree.
- Hand-written SQL (anything Drizzle can't express): `bunx drizzle-kit generate --custom --name <what>` in `apps/api`, then fill the empty file.
- Conventions are in the header of `schema.ts`: UUIDv7 ids from Postgres, `user_id` on every user-owned row, money as `bigint` minor units, `date` for calendar dates, enums for closed sets, deferred foreign keys.

## API (`/api/trpc`)

tRPC v11, mounted with `@hono/trpc-server` (`src/trpc/mount.ts`). The router in `src/trpc/router.ts` is the whole API and its only contract: clients import `type AppRouter` from `@mpf/api/trpc`, a types-only export (a runtime import of server code doesn't resolve, so nothing of the server reaches a bundle). Procedure paths are `group.op` (`transactions.create`); pending actions store them as operation names.

Every procedure is built from one of the builders in `src/trpc/init.ts`, which do the checks in this order: credential (401) → web-only / scope (403) → `Idempotency-Key` (400) → transaction [channel identity re-check → idempotency claim → input (400) → procedure].

- `financeRead` / `financeWrite`: finance data for the web app and the agent (`finance:read` / `finance:write`, writes with an `Idempotency-Key`).
- `webRead` / `webWrite`: web app only (profile, account, category, goal and debt management, `transfers.get`). Chat tokens (`cid`) get `forbidden`, so the agent can neither call nor propose them.
- `webWriteNoKey`: web-only writes without `Idempotency-Key` (chat links): a stored replay of `chatLinks.createCode` would keep the raw link code.
- `agentRead` / `agentWrite`: the agent store (`agent:state`), only with a token for a still-linked chat, no `Idempotency-Key`. A procedure may `throw commitThenFail(error)` to commit its writes and still answer with an error (an action marked `expired` on confirm); in a finance write that is a 500, since the replay would be a stored success.
- `serviceRead` / `serviceWrite`: the service key only (channel link redeem, identity resolve and unlink, inbound events). They act for no user; each procedure finds the user from server state (the code row, the linked identity).

`src/trpc/init.test.ts` lists every procedure with its access (`ACCESS`) and checks credentials, scopes and keys for each; a new procedure fails it until it is listed.

Bodies are capped at 64 KiB (413). Responses carry `Cache-Control: no-store`. Unknown procedures answer `not_found`.

Layout, per module (copy it for the next one):

```text
src/domain/<module>.ts        Domain logic: (tx, userId, args), Drizzle queries, throws DomainError
src/domain/<module>.test.ts   Domain tests against the database
src/trpc/<module>.ts          Router: zod input/output schemas next to the procedures, input -> domain -> DTO
src/trpc/<module>.test.ts     Procedure tests through `clientFor` (test/api.ts)
src/trpc/router.ts            Add the module's router here
```

- A procedure is `financeWrite.input(schema).output(schema).mutation(async ({ ctx, input }) => ...)`. `input` is already validated; `ctx.user.userId` is the only user id there is (never take one from `input`). `ctx.tx` is a read-only snapshot for queries (`readTx`) and the write's SERIALIZABLE transaction for mutations (`withTx`, may run more than once), with the idempotency record in the same transaction.
- Shared zod primitives (ids, money, dates, text) are in `src/trpc/schemas.ts`; DTOs in `src/trpc/dto.ts` (optional fields omitted, never null; `archived` only when true); currency checks in `src/trpc/currency.ts`.
- Errors: throw `DomainError` (`notFound("Account")`, `conflict(...)`, `invalid(path, message)` in `src/domain/errors.ts`). `src/trpc/errors.ts` sets the HTTP status from it and puts its code and details on `error.data` (`apiCode`, `details`): clients branch on those, not on tRPC's codes. Input errors are `validation_failed` with `{ issues: [{ path, message }] }`. Anything else is a logged 500 with no detail.
- Ids are lowercase UUIDs (`idSchema`): anything else is `validation_failed`; missing and other users' rows are both `not_found`. Agent-store ids are any URL-safe string (an unknown one is `not_found`).
- Money: the database stores value × 100 for every currency; `src/domain/money.ts` converts to and from ISO minor units. Request amounts that don't fit exactly are `validation_failed` (`reason: "precision"`), never rounded.

The ledger (`src/domain/ledger.ts`) is the only code that writes a row's money fields or moves `accounts.balance`. Transactions, transfers, account adjustments, goal contributions and debt payments all go through it:

- An entry is one income/expense/adjustment row or a transfer's two legs. `post` writes one, `open` loads one for its owner, `amend` rewrites it, `reverse` deletes it; `ownersOf` labels rows. Balance moves are derived from the rows (post applies their effect, amend the difference, reverse undoes it) as `balance = balance + delta`, accounts in id order, each checked against its currency's range. Concurrent writes to one account collide under SERIALIZABLE and `withTx` reruns the loser, so no delta is lost.
- A transfer is two `transfer` rows sharing `transfer_group_id`, linked to each other, in one currency; either leg's id addresses it.
- Every entry has one owner, with one precedence: the goal contribution that points at either leg, else `transfer` for transfer legs, else the debt payment that points at the row, else `manual`. Only the owner may change it: anyone else gets `conflict` (`transactions.update`/`delete` on a transfer leg, goal or debt row; `transfers.update`/`delete` on a contribution's transfer). Transfer procedures address transfer legs only (`not_found` otherwise).
- Legacy rows with a null `account_id` (account deleted before the migration) skip their balance effect (a transfer leg whose pair is gone can be deleted but not changed), list in the base currency with `accountId: MISSING_ACCOUNT_ID` (a nil UUID no lookup finds), and make a report that would sum them `conflict` (`unknown_currency`).

Search and reports (`src/domain/{transactions,reports}.ts`):

- `transactions.search`: keyset cursor over `(date, created_at, id)`, `created_at` in microseconds (a JS Date would lose them). All filters, `q` included, run in SQL, so only the last page is short.
- Reports: a month is `[first day, first day of next month)`, never a `-31` bound. Totals use SQL aggregates over every row of the range.
- A date the schema accepts but Postgres can't hold (year 0000) is `validation_failed` (SQLSTATE 22008, `src/trpc/errors.ts`); a stored amount or total ISO minor units can't express is `conflict` (`MoneyRangeError`).

Goals and debts (`src/domain/{goals,debts}.ts`), in the base currency:

- A contribution to an account-linked goal is a transfer into the linked account (`ledger.post`); removing the contribution reverses it. A contribution whose transfer is gone (`transaction_id` nulled) only moves `current_amount` on removal. Deleting a goal keeps its transfers as plain transfers.
- A debt payment is an expense on the paying account plus, for a linked debt, an adjustment of minus the principal on the linked account (`ledger.post`). Removing it, or deleting the debt, reverses those entries. Legacy payments with a null `from_account_id` or `source_transaction_id` list with the nil-UUID placeholders (`MISSING_ACCOUNT_ID`, `MISSING_TRANSACTION_ID`) and skip what is gone on removal.
- `current_amount` and `current_balance` move with relative updates; the principal check reads the balance in the same SERIALIZABLE transaction, so racing payments can't pay down more than is left.
- A goal's or debt's linked account, and the accounts a contribution or payment moves money on, must be in the base currency (`validation_failed`).

Tests use `test/api.ts`: `seedUser`, `seedAccount`, `seedCategory`, `seedSubcategory`, `seedTransaction` (rows only, no balance; `null` account for legacy rows), `seedDebt`, `seedDebtPayment`, `seedContribution`, `seedChannelIdentity`, `tokenFor(userId, scopes?)`, `clientFor(app, token)` (a tRPC client called as `client.group.op(input)`, failures as `ApiError` with the API code), `serviceClientFor(app)` (service key), `linkedChat(app)` (a user linked through the real code/redeem/resolve flow, with its agent token), `raw(app, "group.op", input, { token | cookie, idempotencyKey, rawBody })`, `expectApiError(promise, code, status)` and `twoUsers()` for isolation checks. `testApp({ router })` swaps in a router built with the same builders (e.g. a procedure that writes then throws); `probeRouter` (`test/app.ts`) answers who called. `test/trpc.ts` has a typed vanilla client (`trpcFor`) for transport tests.

## Idempotency

Finance writes need `Idempotency-Key` (8-128 of `[A-Za-z0-9._:-]`), one write per HTTP request: batched writes with a key are refused. `(user, key) -> sha256(procedure path + canonical raw input) + response` is stored in `api_idempotency_keys` inside the write's transaction (`src/http/idempotency.ts`). Same key and request: the stored response, `Idempotent-Replayed: true`. Same key, different request or operation: `conflict`. A failed write stores nothing. Concurrent requests with one key serialize: one runs, the others replay it. The key is claimed with `INSERT ... ON CONFLICT DO NOTHING` and the row is only read when the key exists: a `SELECT` under SERIALIZABLE takes index-page read locks, and with clustered UUIDv7 ids every user's write then collided with every other's (about one 500 in ten at 40 concurrent writers). Keep reads of shared, append-heavy tables off the hot write path for the same reason. Keys count as unused after 7 days; `purgeExpiredIdempotencyKeys` deletes them in batches (a retention job).

## Agent store and retention jobs

The chat agent keeps no state of its own: inbound events (dedupe and crash recovery), sessions, messages and pending actions live in the `agent_*` tables (`src/domain/agentStore.ts`). They are ephemeral. Their keys are composite `(x_id, user_id)` like the domain keys, but immediate and `ON DELETE CASCADE`: deleting a session deletes its messages and actions. Unlink and "delete history" delete in one statement, in the request's transaction.

`src/jobs/retention.ts` runs the retention jobs in-process with croner (UTC): idempotency keys (daily), expired link codes (hourly), inbound events 24 h after their last update (hourly), pending actions past `expiresAt` → `expired` (every 15 min), sessions inactive for 30 days and actions of that age (daily). Each step is one autocommitted statement per batch, repeated until a batch comes back short; it repeats its condition on the rows it changes, so a row a request touched meanwhile is left alone. A job runs on one reserved connection that holds a Postgres advisory lock (`pg_try_advisory_lock`) for the run and unlocks it before going back to the pool, so with several API instances only one runs a given job; the others log `job_skipped`. Shutdown stops scheduling, lets runs in progress finish their current batch and waits for them.

## Writes

Every write goes through `withTx(db, async (tx) => ...)` (`src/db/tx.ts`): one `SERIALIZABLE` transaction, rerun on serialization failure (`40001`) or deadlock (`40P01`), up to 10 attempts with jittered backoff capped at 250 ms per retry. The callback can run more than once, so it must not have side effects outside the database.

## Tests

```bash
bun run --filter '@mpf/api' test:once   # or: cd apps/api && bunx vitest
```

Tests need Postgres: the compose server, or any server in `TEST_DATABASE_URL` where the suite may create and drop `dalva_test_*` databases. Each run migrates a template database; each Vitest worker clones its own database from it; every table is truncated before each test. Call the app in-process with `testApp().app.request(...)` (`test/app.ts`), or through the helpers in `test/api.ts` (see Contract routes).
