<p align="center">
  <img src="apps/web/public/logo.svg" alt="Dalva Logo" width="120" height="120" />
</p>

<h1 align="center">Dalva</h1>

<p align="center">
  A privacy-first personal finance manager.<br/>
  Track accounts, transactions, categories, transfers, and savings goals in one place.
</p>

<p align="center">
  <strong>No bank integrations. The user is the source of truth.</strong>
</p>

---

## Overview

Dalva is a manual-first personal finance app for people who want a clean, opinionated way to track where money lives, where it moves, and what it is working toward.

The app is currently centered around:

| Module | Status | Notes |
|--------|--------|-------|
| Accounts | Implemented | Create, edit, archive, restore, delete, and adjust balances |
| Transactions | Implemented | Record income and expenses with filters and account balance effects |
| Transfers | Implemented | Move money between accounts using paired transfer transactions |
| Categories | Implemented | Default category seeding, custom categories, and subcategories |
| Onboarding | Implemented | Currency, starter accounts, and starter category selection |
| Savings Goals | Implemented | Goal CRUD, contribution history, progress tracking |
| Dashboard | Partially implemented | Real account, transaction, goal, debt, and net worth data; some widgets still remain mock-backed |
| Budgets | Planned | Sidebar placeholder exists, dedicated module not built yet |
| Debts | Implemented | Debt CRUD and payment history |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | TanStack Start + TanStack Router + React 19 + React Query |
| Backend | Convex |
| Auth | Convex Auth with email/password |
| UI | shadcn/ui v4 + Tailwind CSS v4 + Radix UI + Lucide |
| Charts | Recharts |
| Package Manager | Bun workspaces |
| Backend Testing | Vitest + convex-test |
| E2E Testing | Playwright |

---

## Monorepo Structure

```text
my-personal-finance/
|- apps/web/                  @mpf/web              Frontend app
|- apps/agent/                @mpf/agent            Telegram chat agent
|- packages/backend/          @mpf/backend          Convex backend
|- packages/finance-contract/ @mpf/finance-contract Finance API schemas shared by backend and agent
|- scripts/                                         Local setup and dev helpers
`- docs/                                            Product and design docs
```

---

## Current Product State

Implemented today:

- Marketing landing page with dark mode
- Email/password auth with Convex Auth
- Auth-aware onboarding flow
- Authenticated app shell with persistent sidebar and floating quick actions
- Accounts management
- Transactions management for income and expenses
- Transfer creation and editing flows
- Categories and subcategories management
- Savings goals with contribution tracking
- Debts with payment tracking
- Settings with Telegram linking
- Dashboard with real recent transactions, spending, cashflow, goals, debt, and net worth data

Still not fully wired:

- Forgot password email delivery
- Google OAuth provider setup
- Dedicated budgets page
- Some dashboard cards still use mock data while those modules are being built
- Net worth trend/history badge, which needs historical balance snapshots or equivalent reporting support

---

## Getting Started

### Prerequisites

- Bun
- Docker (Postgres from `compose.dev.yml`), or any Postgres 18 server on `127.0.0.1:5432`

### Setup

```bash
bun install
bun run setup
```

`setup` is safe to re-run. It:

- creates `apps/api/.env.local` from `apps/api/.env.example` and generates the secrets that are missing or still placeholders:
  - `BETTER_AUTH_SECRET`: signs session cookies
  - `FINANCE_API_TOKEN_SECRET`: signs the user tokens the chat agent sends
  - `FINANCE_API_SERVICE_KEY`: the chat agent's own key for the service routes
- starts Postgres with `docker compose -f compose.dev.yml up -d` (skipped when a server already answers on `DATABASE_URL`)
- applies the migrations
- creates `apps/agent/.env` from the example if missing

Other API variables (`DATABASE_URL`, `PORT`, `PUBLIC_URL`, `CLIENT_IP_HEADER`, `LOG_LEVEL`) are documented in `apps/api/.env.example`. Convex is not part of local dev any more: production runs it from the `legacy-convex` branch until the cutover.

### Development

```bash
bun run dev
```

Starts Postgres (if needed), the API on http://localhost:4000 with migrations applied, the web app on http://localhost:3000 and the Telegram agent. The web dev server proxies `/api` to the API (`DALVA_API_URL` overrides the target), so cookies stay first-party. The agent waits for the API, and exits on its own without breaking the others if `apps/agent/.env` has no bot token or LLM key yet.

Transactions, transfers, the dashboard data, goals, debts and settings still use Convex hooks and show empty or error states until they move to the API.

Other useful commands:

```bash
bun run dev:api      # Postgres + migrations + API
bun run dev:web
bun run dev:agent
bun run dev:backend  # Convex dev (legacy)
bun run build
bun run build:web
bun run typecheck
bun run lint
bun run test:once
bun run test:e2e     # starts its own API on a fresh dalva_e2e_<port> database
```

---

## App Routes

Public routes:

- `/`
- `/login`
- `/register`
- `/forgot-password`
- `/onboarding`

Authenticated routes:

- `/dashboard`
- `/accounts`
- `/transactions`
- `/categories`
- `/goals`
- `/debts`
- `/settings`

Authenticated pages share a persistent app shell with sidebar navigation, top bar, dark mode toggle, sign out, and floating quick actions for income, expense, and transfer entry.

---

## Implementation Notes

- Amounts are stored in minor units in the backend.
- Transfers are modeled as two linked `transactions` records with a shared `transferGroupId`.
- Categories are seeded during onboarding and can be extended later with custom categories and subcategories.
- Savings goals track progress separately from account balances, with goal contributions stored in their own table.
- The frontend uses `convexQuery(...)` with React Query for reads and `useConvexMutation(...)` for writes.

---

## Testing

Backend tests cover the Convex domain modules, including accounts, categories, onboarding/profile flows, transactions, transfers, savings goals, and goal contributions.

Playwright E2E coverage currently includes:

- landing page
- auth flows
- onboarding
- accounts
- transactions
- transfers
- goals

Run them with:

```bash
bun run test:once
bun run test:e2e
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/business.md`](docs/business.md) | Product vision and module definitions |
| [`docs/PRD.md`](docs/PRD.md) | Full requirements and roadmap |
| [`docs/design-system.md`](docs/design-system.md) | Visual system, tokens, and UI rules |
| [`CLAUDE.md`](CLAUDE.md) | Repo-specific engineering and implementation guidance |

---

## License

Private project. All rights reserved.
