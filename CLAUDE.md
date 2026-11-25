# DALVA -- Personal Finance Manager

## What This Is

A privacy-first personal finance app. Users manually track accounts, transactions, categories, transfers, savings goals and debts. No bank integrations -- the user is the source of truth. A Telegram agent reads and records transactions for a linked account.

Product docs: `docs/business.md` (vision), `docs/PRD.md` (requirements), `docs/design-system.md` (UI spec), `docs/deploy.md` (production).

## Monorepo Structure

```text
dalva-personal-finance-app/
|- apps/web/                  @mpf/web              Frontend (TanStack Start + React 19)
|- apps/api/                  @mpf/api              Backend (Bun + Hono + Drizzle + Postgres + Better Auth)
|- apps/agent/                @mpf/agent            Telegram agent (Bun + Hono)
|- packages/shared/          @mpf/shared           Money, date and agent-limit helpers shared by web, API and agent
|- deploy/                                          Production compose stack
|- scripts/                                         Local setup and dev helpers
`- docs/                                            Product, design and deploy docs
```

**Package manager:** Bun workspaces (root `package.json`).

### Commands

```bash
bun run setup        # One-time local setup: apps/api/.env.local secrets, Postgres (compose.dev.yml), migrations
bun run dev          # Start API (Postgres + migrations), web and agent together
bun run dev:api      # Start the API only (Postgres + migrations first)
bun run dev:web      # Start the web app only (proxies /api to localhost:4000)
bun run dev:agent    # Start the Telegram agent only (against apps/api; waits for it)
bun run build        # Build apps/*
bun run build:web    # Build the web app
bun run typecheck    # Typecheck all packages
bun run lint         # Lint all packages
bun run test         # Run unit tests in watch mode
bun run test:once    # Run unit tests once (shared, API, agent, web)
bun run test:e2e     # Run Playwright E2E tests (starts its own API on a fresh dalva_e2e_<port> database)
bun run db:generate  # Generate a Drizzle migration after changing apps/api/src/db/schema.ts
bun run db:migrate   # Apply migrations
```

## apps/web -- Frontend

**Stack:** TanStack Start (SSR) + TanStack Router (file-based routing) + React 19 + TanStack React Query + `@trpc/tanstack-react-query` against `apps/api` (`type AppRouter` from `@mpf/api/trpc`).

**UI:** shadcn/ui v4 (`radix-nova` style) + Tailwind CSS v4 (CSS-first) + Radix UI + Lucide icons + Recharts.

**Design system:** Wise-inspired. Tokens live in `apps/web/src/styles.css`.

### Frontend Implementation Patterns

- Protected app pages live under `apps/web/src/routes/_authenticated/`.
- `apps/web/src/routes/_authenticated.tsx` is the persistent authenticated shell. It owns:
  - auth guard
  - onboarding gate
  - sidebar layout
  - top bar
  - floating quick actions
  - shared create transaction / create transfer dialogs
- Onboarding lives at `/onboarding` and must complete before authenticated users can access the main app.
- Auth is Better Auth (`src/lib/auth-client.ts`): same-origin cookie session at `/api/auth/*`. `useSession()` reads it, `useSignOut()` signs out; sign in/up/out call `resetUserCache()` so no data of the previous user stays cached.
- Data comes from `apps/api` through tRPC (`src/lib/api/`): reads with `useQuery(categoriesQuery(...))` (factories over `trpc.<group>.<op>.queryOptions` in `queries.ts`, `ledger.ts`, `dashboard.ts`; invalidation prefixes in `keys.ts`), writes with `useApiMutation("categories", "create")`. Types come from `type AppRouter` in `@mpf/api/trpc` (records in `types.ts`), never a runtime import of `apps/api`.
- `idempotencyLink` (`trpc.ts`) sends one `Idempotency-Key` per write, reused while the same input is retried before a success. `useApiMutation` invalidates what `INVALIDATES` in `mutations.ts` lists for that write. Add an entry for every new write.
- Show failures with `apiErrorMessage()`: `ErrorState` for a page's data, `FormError` inside dialogs (`src/components/error-state.tsx`). It reads the API code from `error.data.apiCode`.
- Money from the API is `{ amountMinor, currency }` in ISO minor units: format with `formatMinor` and parse with `parseDecimalInput` (`src/lib/money.ts`), or `CurrencyInput` with `fractionDigits` + `parseCurrencyInput`. `formatCurrency(cents)` is only for the mock budget card.
- Transactions, transfers and the dashboard read through `src/lib/api/ledger.ts` and `src/lib/api/dashboard.ts`. Rows owned by goals or debts (`managedBy` on search items) offer no edit or delete. Edits send only changed fields; `null` clears a nullable one.
- Goal and debt account pickers list only accounts in the base currency (`accountsForBaseCurrency` in `src/lib/accounts.ts`): the API refuses others.
- Settings → Telegram gets the bot username from `chatLinks.list` (`botUsernames`, API setting `TELEGRAM_BOT_USERNAME`) and polls the list while a link code is pending.
- `src/router.tsx` sets a 30 second `staleTime`, retries transient errors only, and turns any API 401 into a session re-check (the guard then redirects to /login).

### Frontend UI Rule

- Product forms should default to the dialog pattern established in `apps/web/src/components/accounts/account-form-dialog.tsx`
- Use the same dialog shell structure: `max-w-md`, `p-0`, `gap-0`, `overflow-hidden`, compact header, padded content, right-aligned footer actions
- When a form has a primary amount or value, place it prominently at the top with large typography and a bottom border instead of a boxed input
- Build supporting fields as icon-led rows with bottom dividers and lightweight inline controls
- Keep validation and async errors inside the content area above the footer
- Use `size="default"` footer buttons
- Reuse this pattern across accounts, transactions, transfers, categories, and goals unless the interaction clearly needs something else

### Additional Frontend Patterns

- The authenticated app uses a persistent sidebar, not top-nav page remounts, so child pages should render inside the existing shell cleanly
- Quick entry flows for income, expense, and transfer should stay accessible from the floating action menu
- Dashboard pages can mix real data and mock-backed cards while upcoming modules are still under construction, but docs and code comments should make that explicit
- Keep list pages simple: page header, optional filters/toggles, empty state, list/grid body, dialogs for create/edit actions

### Path Aliases

- `#/` -> `./src/*` via `package.json` imports and TypeScript paths
- `@/` -> `./src/*` via TypeScript paths

### Key Files

| File | Purpose |
| ---- | ------- |
| `apps/web/src/styles.css` | Global design tokens and theme variables |
| `apps/web/src/router.tsx` | TanStack Router + React Query wiring |
| `apps/web/src/routes/__root.tsx` | Root document, stylesheet, anti-flash theme script, devtools |
| `apps/web/src/routes/_authenticated.tsx` | Persistent authenticated layout and shared quick actions |
| `apps/web/src/routes/onboarding.tsx` | 3-step onboarding flow |
| `apps/web/src/routes/_authenticated/dashboard.tsx` | Main dashboard page |
| `apps/web/src/routes/_authenticated/accounts.tsx` | Accounts management page |
| `apps/web/src/routes/_authenticated/transactions.tsx` | Transactions page with filters and transfer edit flow |
| `apps/web/src/routes/_authenticated/categories.tsx` | Categories and subcategories management |
| `apps/web/src/routes/_authenticated/goals.tsx` | Savings goals page |
| `apps/web/src/routes/_authenticated/debts.tsx` | Debts page |
| `apps/web/src/routes/_authenticated/settings.tsx` | Settings (Telegram linking) |
| `apps/web/src/components/dashboard/app-sidebar.tsx` | Authenticated sidebar navigation |
| `apps/web/src/components/accounts/account-form-dialog.tsx` | Canonical product form pattern |
| `apps/web/src/components/transactions/transaction-form-dialog.tsx` | Income/expense dialog |
| `apps/web/src/components/transactions/transfer-form-dialog.tsx` | Transfer dialog |
| `apps/web/e2e/*.spec.ts` | Playwright E2E coverage |
| `apps/web/src/lib/api/` | Contract client, query keys, query options, `useApiMutation`, error messages |
| `apps/web/src/lib/auth-client.ts` | Better Auth client and session query |
| `apps/api/.env.local` | API env written by `bun run setup` (see `apps/api/.env.example`) |

### Routing

File-based routing via TanStack Router.

```text
apps/web/src/routes/
|- __root.tsx
|- index.tsx
|- login.tsx
|- register.tsx
|- forgot-password.tsx
|- onboarding.tsx
|- _authenticated.tsx
`- _authenticated/
   |- dashboard.tsx
   |- accounts.tsx
   |- transactions.tsx
   |- categories.tsx
   |- goals.tsx
   |- debts.tsx
   `- settings.tsx
```

### Backend Integration

- The web app talks to `apps/api` on the same origin: the Vite proxy in dev (`/api` → `DALVA_API_URL`, default `http://localhost:4000`), the reverse proxy in production
- Every page reads and writes through `apps/api`

### E2E Testing (Playwright)

**Stack:** Playwright Test.

Tests currently live in `apps/web/e2e/` and cover:

- `landing.spec.ts`
- `auth.spec.ts`
- `onboarding.spec.ts`
- `accounts.spec.ts`
- `transactions.spec.ts`
- `transfers.spec.ts`
- `goals.spec.ts`
- `categories.spec.ts`
- `dashboard.spec.ts`
- `debts.spec.ts`
- `settings.spec.ts` links a chat through the service route with the key `playwright.config.ts` generates per run (`E2E_FINANCE_API_SERVICE_KEY`)

Playwright starts `apps/api` on a fresh `dalva_e2e_<port>` database (`apps/api/scripts/e2e-server.ts`) and the web dev server. `E2E_DATABASE_URL`, `E2E_WEB_PORT` and `E2E_API_PORT` override the defaults.

#### Commands

```bash
bun run test:e2e
```

From inside `apps/web/`:

```bash
bun run test:e2e:ui
bun run test:e2e:headed
bun run test:e2e:report
bunx playwright test --project=chromium
```

#### E2E Test Patterns

- Prefer `page.getByRole()`, `page.getByLabel()`, and `page.getByText()`
- Be aware TanStack Router devtools can add extra `aria-label` values in dev mode
- Use `baseURL` and relative routes in tests
- Wait explicitly for async auth and query-driven UI when needed
- Each test is isolated in a fresh browser context

## apps/api -- Backend

**Stack:** Bun + Hono + Drizzle + Postgres 18 + Better Auth. Details in `apps/api/README.md`.

### Backend Implementation Patterns

- The API is tRPC at `/api/trpc` (`src/trpc/`). `src/trpc/router.ts` is the only contract: zod input/output schemas live next to the procedures, `type AppRouter` is exported as `@mpf/api/trpc`
- Every procedure uses a builder from `src/trpc/init.ts` (`financeRead`/`financeWrite`, `webRead`/`webWrite`, `webWriteNoKey`, `agentRead`/`agentWrite`, `serviceRead`/`serviceWrite`): credentials, scopes, `Idempotency-Key`, the transaction (`ctx.tx`) and error mapping. List new procedures in `ACCESS` (`src/trpc/init.test.ts`)
- Throw `DomainError`; clients get its code on `error.data.apiCode`
- The agent calls the API through a vanilla tRPC client (`apps/agent/src/core/finance.ts`): failures surface as `FinanceError` with the API code; pending actions run `finance[group][op].mutate(input, { context: { idempotencyKey } })`
- Callers are resolved by `src/http/principal.ts`: session cookie (web), bearer user token (agent, per linked chat) or service key (agent service procedures)
- Never accept `userId` from the client; every query filters by the principal's user
- Every write runs in one `SERIALIZABLE` transaction with retry on `40001` (`src/db/tx.ts`)
- Amounts are `bigint` minor units; `src/domain/money.ts` converts to and from ISO minor units
- Ids are UUIDv7; cross-row references are composite `(id, user_id)` foreign keys, `DEFERRABLE INITIALLY DEFERRED`
- `transactions.account_id`, `debt_payments.from_account_id` and `debt_payments.source_transaction_id` are nullable on legacy rows; code must handle null
- Schema changes: edit `src/db/schema.ts`, run `bun run db:generate`, commit `apps/api/drizzle/`. CI fails when they disagree

### Domain Patterns

- `accounts` store balances directly. Only the ledger (`src/domain/ledger.ts`) moves them: transactions, transfers, adjustments, goals and debts post, amend and reverse entries through it and never compute a signed delta
- Who may change a row (manual, transfer, goal contribution, debt payment) is resolved once, in the ledger
- `transactions` hold income, expense, adjustment and transfer rows
- Transfers are two linked `transactions` rows with a shared `transfer_group_id`
- Categories are seeded during onboarding and then customized by the user
- Savings goals with contributions; debts with payments. Both work in the base currency only
- Chat agent state (`agent_*` tables) is ephemeral and cleaned by `src/jobs/retention.ts`

### Key Files

| File | Purpose |
| ---- | ------- |
| `apps/api/src/db/schema.ts` | Data model and conventions |
| `apps/api/src/db/tx.ts` | Serializable transaction helper with retry |
| `apps/api/src/auth/auth.ts` | Better Auth setup |
| `apps/api/src/trpc/init.ts` | Context and procedure builders |
| `apps/api/src/trpc/router.ts` | The API: every router, `type AppRouter` |
| `apps/api/src/http/principal.ts` | Credential resolution |
| `apps/api/src/domain/*.ts` | Domain logic per module |
| `apps/api/src/domain/ledger.ts` | Entries, owners and every balance move |
| `apps/api/src/trpc/*.ts` | Routers per module, schemas next to the procedures |
| `apps/api/src/jobs/retention.ts` | Retention jobs (croner) |
| `apps/api/test/api.ts` | Seed and client helpers for tests |

### Testing

**Stack:** Vitest against a real Postgres. Each test file gets its own database (`apps/api/test/global-setup.ts`).

- Domain tests in `src/domain/*.test.ts`, procedure tests in `src/trpc/*.test.ts`
- Use the helpers in `test/api.ts`: `seedUser`, `seedAccount`, `tokenFor`, `clientFor` (`client.group.op(input)`), `raw`, `twoUsers()` for isolation checks, `expectApiError`
- Prefer partial assertions like `toMatchObject()`

### Development Workflow -- Test-First

1. Write or update tests in `apps/api`
2. Run them and confirm they fail when appropriate
3. Implement the domain and the procedure (its schemas in the same file)
4. Re-run `bun run test:once` and `bun run typecheck`

## Development Workflow -- Full Feature Lifecycle

For non-trivial product work:

1. Backend first
   - add tests and implement in `apps/api` (domain + procedure); web and agent get the types from `AppRouter`
2. Frontend next
   - add/update routes and components
   - add an `INVALIDATES` entry for every new write
   - follow the existing dialog and list-page patterns
3. E2E last
   - add/update Playwright coverage in `apps/web/e2e/`
4. Verify
   - `bun run test:once`
   - `bun run test:e2e`
   - `bun run typecheck`

## Design System Quick Reference

Wise-inspired. Full spec in `docs/design-system.md`.

**Font:** Inter.

**Core colors:**

| Token | Value | Usage |
| ----- | ----- | ----- |
| `--primary` | `#163300` | Buttons, links, focus |
| `--primary-foreground` | `#9FE870` | Text on primary |
| `--accent` | `#9FE870` | CTAs and highlights |
| `--accent-foreground` | `#163300` | Text on accent |
| `--destructive` | `#A8200D` | Errors and destructive actions |
| `--background` | `#FFFFFF` | Page background |
| `--foreground` | `#0E0F0C` | Primary text |
| `--muted-foreground` | `#454745` | Secondary text |
| `--border` | `rgba(14,15,12,0.12)` | Borders |

**Forms:** Default to the modal form pattern used across accounts, transactions, transfers, categories, and goals.

**Dark mode:** Implemented. Theme preference is stored in `localStorage` and applied early via the anti-flash script in `__root.tsx`.

## Project Status

**Implemented:**

- Landing page with responsive nav and dark mode
- Email/password auth with Better Auth
- Onboarding flow for currency, starter accounts, and starter categories
- Persistent authenticated shell with sidebar, sign out, theme toggle, and floating quick actions
- Dashboard with real accounts, transaction summaries, cashflow, category spending, recent transactions, goals and debts
- Accounts, transactions, transfers, categories, savings goals and debts
- Settings with Telegram linking; Telegram agent for reads and writes
- Production on one compose stack (`deploy/`)

**Partial or not yet wired:**

- Forgot password still needs email infrastructure
- Google OAuth button is present but provider wiring is not done
- Budgets have no page or backend module yet; the budget card on the dashboard is mock data

**Next steps:** live updates (SSE), password reset email and Google OAuth, metrics and alerts, budgets, recurring transactions.
