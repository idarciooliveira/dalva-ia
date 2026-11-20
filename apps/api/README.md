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

Contract routes under `/api/v1/*` get a principal from `src/http/principal.ts`: one middleware turns the request into "who is calling, with what scopes", and routes guard with `requireUser(...scopes)`. Today the only source is the session cookie (full finance access); the agent's bearer token and service key slot in as further sources. Anonymous or invalid credentials answer with the contract's `unauthorized` envelope, a missing scope with `forbidden`.

Password hashes from Convex Auth (Lucia `Scrypt`) use the same format as Better Auth's and verify as they are, so imported users keep their passwords.

## Schema and migrations

- `src/db/schema.ts` is the source of truth. After changing it, run `bun run db:generate` and commit the new file in `drizzle/`. CI fails when the schema and the migrations disagree.
- Hand-written SQL (anything Drizzle can't express): `bunx drizzle-kit generate --custom --name <what>` in `apps/api`, then fill the empty file.
- Conventions are in the header of `schema.ts`: UUIDv7 ids from Postgres, `user_id` on every user-owned row, money as `bigint` minor units, `date` for calendar dates, enums for closed sets, deferred foreign keys.

## Writes

Every write goes through `withTx(db, async (tx) => ...)` (`src/db/tx.ts`): one `SERIALIZABLE` transaction, rerun on serialization failure (`40001`) or deadlock (`40P01`), up to 5 attempts. The callback can run more than once, so it must not have side effects outside the database.

## Tests

```bash
bun run --filter '@mpf/api' test:once   # or: cd apps/api && bunx vitest
```

Tests need Postgres: the compose server, or any server in `TEST_DATABASE_URL` where the suite may create and drop `dalva_test_*` databases. Each run migrates a template database; each Vitest worker clones its own database from it; every table is truncated before each test. Call the app in-process with `createApp({ db: testDb(), logger }).request(...)`.
