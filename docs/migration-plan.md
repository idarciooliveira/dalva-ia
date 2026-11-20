# Migration plan: Convex → own backend, single compose deploy

Replace Convex with `apps/api` (Bun + Hono + Drizzle + Postgres + Better Auth). Ship web, API, agent and Postgres from one `docker compose` on the VPS. Vercel and Convex Cloud go away.

## Decisions

- Auth: Better Auth (email/password, same-origin cookie sessions).
- ORM and migrations: Drizzle + drizzle-kit.
- Agent chat history is not migrated. Linked Telegram chats are.
- SSE live updates come after cutover. Until then: React Query invalidation + refetch on focus.
- `@mpf/finance-contract` is the single API contract for agent and web. It gets extended with the web-only operations.

## Target

```text
cloudflared ──> web (Caddy, single entry)
                 ├─ /api/auth/*          → api:4000   Better Auth
                 ├─ /api/v1/*            → api:4000   contract routes
                 ├─ /webhooks/telegram   → agent:3000
                 └─ /*                   → static SPA
api   ──> postgres
agent ──> http://api:4000/api/v1
migrate (one-shot) ──> postgres      backup (nightly pg_dump)
```

```text
apps/api/src/
  db/        Drizzle schema, client, tx helper
  domain/    ported from packages/backend/convex/domain
  http/      contract router, envelope, idempotency, principals
  auth/      Better Auth
  jobs/      retention jobs
apps/api/drizzle/   SQL migrations
```

## Rules for every PR

- Tests first: port the matching Convex tests, then the code.
- CI green: typecheck, lint, unit tests. Playwright from PR 11 on.
- Merges to `main`. Production stays on Convex until PR 13.
- Every write runs in one `SERIALIZABLE` transaction with retry on `40001`.
- Every query filters by `userId`. No `userId` from the client.
- Amounts stay in minor units, `bigint` in Postgres.
- Ids are UUIDv7 (Postgres 18 native `uuidv7()`).
- Domain FKs are `DEFERRABLE INITIALLY DEFERRED`.
- Cross-row references are composite `(id, user_id)` FKs.
- `transactions.account_id`, `debt_payments.from_account_id` and `debt_payments.source_transaction_id` are nullable: Convex data can hold orphans. Ported code must handle null.
- `date` columns reject `YYYY-MM-31` bounds that Convex compared as strings. Compute the real month end.

## Production freeze

Before PR 9, cut `legacy-convex` from `main`:

- Vercel production branch → `legacy-convex`.
- `convex deploy` only from `legacy-convex`.
- Pin `AGENT_IMAGE_TAG` on the VPS to a short SHA.

Hotfixes for production go to `legacy-convex` and are ported to `main` by hand.

## PRs

### PR 1: cleanup, pass 1 (S)

No behaviour change.

- Remove `@tanstack/router-plugin` from web (no imports; the Start plugin brings it). Confirm with build.
- Pin the five `latest` TanStack versions to what `bun.lock` resolves.
- Align Vitest: web is on `^3`, the rest on `^4`.
- Move build-only packages in web to `devDependencies`: `shadcn`, `tailwindcss`, `@tailwindcss/vite`.
- Check `@tanstack/react-router-ssr-query`: the app builds in SPA mode. Remove if the router works without it.
- `playwright.yml`: pin `bun-version: 1.4.0`, `bun install --frozen-lockfile`.
- Delete `apps/web/.cta.json` and `TODO.MD`.
- Run `bunx knip` once and remove unused files, exports and dependencies it confirms. Do not add knip as a dependency.
- Fix stale README rows (Debts is implemented).

Done when: build, typecheck, lint, unit and E2E pass with a smaller `bun.lock`.

### PR 2: API scaffold, Postgres, Drizzle (M) — merged, #16

- `apps/api`: Hono app, `/health`, zod config, structured logs.
- Drizzle schema for every table in `convex/schema.ts` except the agent ephemeral ones (PR 8) and the auth tables (PR 3). The same indexes, partial unique indexes for channel identities.
- First migration. Scripts: `db:generate`, `db:migrate`, `dev:api`.
- `withTx`: `SERIALIZABLE` + retry.
- Test harness: Vitest + real Postgres, one database per worker from a migrated template, truncate between tests.
- `compose.dev.yml` with Postgres 18 for local dev. CI gets a Postgres service.

Done when: migrations apply on an empty database and a sample repository test runs in CI.

### PR 3: Better Auth and principals (M) — merged, #17

- Better Auth with the Drizzle adapter, mounted at `/api/auth/*`. Tables `users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, plus FKs from the domain tables to `users`.
- Principal middleware: session cookie → user with full scopes. Bearer JWT and service key are added in PR 4 and PR 8.
- Lucia `Scrypt` hashes from Convex Auth verify as they are. No custom verifier.
- Production needs `NODE_ENV=production`, an https `PUBLIC_URL` and `CLIENT_IP_HEADER` (set them in PR 12).

Done when: sign up, sign in, sign out and session read pass through HTTP tests.

### PR 3b: composite user foreign keys (S)

- `UNIQUE (id, user_id)` on accounts, categories, subcategories, transactions, savings goals, debts.
- Every FK between domain rows becomes `(x_id, user_id) REFERENCES t (id, user_id)`: Postgres refuses a row pointing at another user's row. Still deferred, MATCH SIMPLE for the nullable columns, `ON DELETE SET NULL (x_id)` where it nulled before.

Done when: every composite FK has a cross-user rejection test and a same-user acceptance test.

### PR 4: contract router, profiles, accounts (L)

- Router driven by the contract route map: validation, envelope, error codes, 64 KiB body cap.
- Idempotency keys stored in the write's own transaction.
- User tokens (HS256, scopes, `cid`): mint and verify.
- Domain + routes: profiles, accounts, balance adjustments.
- Contract additions for web: profile get/create/complete onboarding, account create/update/archive/restore/delete.

Done when: ported `accounts`, `userProfiles`, `idempotency`, `tokens`, `errors`, `router` tests pass.

### PR 5: categories and subcategories (M)

- Domain + routes, default seeding.
- Contract additions: category and subcategory CRUD, archive/restore, seed, default list.

### PR 6: transactions, transfers, reports (L)

- Domain + routes: transactions, transfers (paired legs), search, summary, spending by category, cashflow, net worth.
- Contract addition: `transfers.get`.

Done when: ported `transactions`, `transfers`, `dashboard`, `reports`, `search`, `money` tests pass, including the balance and transfer-leg guards.

### PR 7: goals and debts (M)

- Domain + routes: goals, contributions, debts, debt payments, debt summary.
- Contract additions: goal and debt create/update/archive/restore/delete.

### PR 8: channel links, agent store, jobs (L)

- Service-key auth. Routes: link code create/redeem, identity resolve/unlink/read-only, events, sessions, messages, pending actions, history delete.
- Five retention jobs in-process (croner), each looping until a batch comes back short, guarded by a Postgres advisory lock.
- `dev:agent` points at `apps/api`.

Done when: ported `channels`, `agent`, `agentStore`, `channelLinks` tests pass, and the agent test suite and evals pass against the new API.

### PR 9: web foundation, auth, onboarding, accounts, categories (L)

Cut `legacy-convex` first (see Production freeze).

- Vite dev proxy `/api` → `localhost:4000`.
- Contract client + React Query layer: query-key factory, invalidation map per mutation, generated `Idempotency-Key` per write.
- Better Auth client replaces `useConvexAuth` and `useAuthActions`: login, register, guard, sign out.
- Money: the contract speaks decimal strings; adapt the format helpers.
- Swap onboarding, accounts, categories.
- `bun run setup` and `bun run dev` start Postgres, API, web, agent.

The other pages stay on Convex and will not load data on `main` until PR 11. Production is frozen, so this is fine.

### PR 10: web transactions, transfers, dashboard (M)

### PR 11: web goals, debts, settings; Convex out of web (M)

- Bot username comes from the API with the channel-link data. No `VITE_` variables left.
- Remove `convex`, `@convex-dev/auth`, `@convex-dev/react-query` from web.
- Playwright runs against the local stack in CI. Drop the `VITE_CONVEX_URL` secret from the workflow.

Done when: full E2E suite passes with no Convex process running.

### PR 12: compose deploy (M)

- `apps/api/Dockerfile`, `apps/web/Dockerfile` (Bun build → Caddy), per-Dockerfile `.dockerignore`.
- `deploy/docker-compose.yml`: `postgres`, `migrate`, `api`, `web`, `agent`, `cloudflared`, `backup`. No published ports. Same hardening as the current agent service.
- `deploy/.env.example`: one file for every secret.
- `images.yml`: matrix for `dalva-api`, `dalva-web`, `dalva-agent`, tagged `:sha` and `:latest`.
- `docs/deploy.md` replaces `docs/deploy-agent.md`, with backup and restore steps.

Done when: the stack runs on the VPS under a staging hostname with an empty database, and a backup restores into a scratch database.

### PR 13: data migration and cutover (M)

- `scripts/migrate-from-convex.ts`: reads a `convex export`, maps ids, writes Postgres. Migrates users and password hashes, profiles, all finance tables, channel identities.
- Import rules: lowercase emails and merge case-only duplicates; supply `users.name`; validate password hashes as lowercase hex; build UUIDv7 ids from `_creationTime`; check every amount is an integer; write null for dangling account and transaction references.
- Verification: row counts per table; each account balance recomputed from its transactions; orphan count reported.
- Runbook in `docs/deploy.md`.

Cutover:

1. Dry run against a production export on a dev machine.
2. Freeze: web in maintenance, agent stopped.
3. Export, migrate, verify.
4. Point the tunnel at the new stack. Re-register the Telegram webhook.
5. Smoke test: login, transaction, transfer, Telegram message.
6. Keep Convex and Vercel untouched for two weeks as rollback.

Users log in once after cutover.

### PR 14: cleanup, pass 2 (S)

After the rollback window.

- Delete `packages/backend`, `apps/web/vercel.json`, `deploy/agent/`, the `legacy-convex` branch.
- Remove what is left of `convex`, `convex-test`, `@edge-runtime/vm`, `@auth/core`, the Convex agent skills.
- Run `bunx knip` again.
- Rewrite README and CLAUDE.md for the new stack.
- Delete the Convex deployment, the Vercel project and their GitHub secrets.

## After cutover

- PR 15: SSE live updates (`LISTEN/NOTIFY` → `/api/v1/events` → query invalidation).
- PR 16: password reset email and Google OAuth through Better Auth.
- PR 17: metrics and alerts for API, Postgres and backups.

## Risks

- Dual maintenance between PR 9 and PR 13. Keep the window short; hotfix only on `legacy-convex`.
- We own backups and upgrades. A tested restore is part of PR 12.
- Live updates are weaker until PR 15.
