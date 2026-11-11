# DALVA -- Personal Finance Manager

## What This Is

A privacy-first personal finance app. Users manually track accounts, transactions, categories, transfers, and savings goals. No bank integrations -- the user is the source of truth.

Product docs: `docs/business.md` (vision), `docs/PRD.md` (requirements), `docs/design-system.md` (UI spec).

## Monorepo Structure

```text
my-personal-finance/
|- apps/web/          @mpf/web     Frontend (TanStack Start + React 19)
|- packages/backend/  @mpf/backend Backend (Convex)
`- docs/                           Product docs and design system
```

**Package manager:** Bun workspaces (root `package.json`).

### Commands

```bash
bun run dev          # Start the web app
bun run dev:web      # Start the web app explicitly
bun run dev:backend  # Start Convex dev
bun run build        # Build apps/* (currently the web app)
bun run build:web    # Build the web app
bun run typecheck    # Typecheck all packages
bun run lint         # Lint all packages
bun run test         # Run backend tests in watch mode
bun run test:once    # Run backend tests once
bun run test:e2e     # Run Playwright E2E tests
```

## apps/web -- Frontend

**Stack:** TanStack Start (SSR) + TanStack Router (file-based routing) + React 19 + TanStack React Query + Convex React client.

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
- Prefer `useQuery(convexQuery(...))` for reads and `useMutation({ mutationFn: useConvexMutation(...) })` for writes.
- The app uses React Query as the main frontend data layer and Convex as the backing source of truth.
- Root router setup in `src/router.tsx` configures `ConvexQueryClient`, `ConvexAuthProvider`, and a 30 second `staleTime` because Convex subscriptions keep data fresh.

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
| `apps/web/src/router.tsx` | TanStack Router + React Query + Convex client wiring |
| `apps/web/src/routes/__root.tsx` | Root document, stylesheet, anti-flash theme script, devtools |
| `apps/web/src/routes/_authenticated.tsx` | Persistent authenticated layout and shared quick actions |
| `apps/web/src/routes/onboarding.tsx` | 3-step onboarding flow |
| `apps/web/src/routes/_authenticated/dashboard.tsx` | Main dashboard page |
| `apps/web/src/routes/_authenticated/accounts.tsx` | Accounts management page |
| `apps/web/src/routes/_authenticated/transactions.tsx` | Transactions page with filters and transfer edit flow |
| `apps/web/src/routes/_authenticated/categories.tsx` | Categories and subcategories management |
| `apps/web/src/routes/_authenticated/goals.tsx` | Savings goals page |
| `apps/web/src/routes/_authenticated/settings.tsx` | Settings (Telegram linking) |
| `apps/web/src/components/dashboard/app-sidebar.tsx` | Authenticated sidebar navigation |
| `apps/web/src/components/accounts/account-form-dialog.tsx` | Canonical product form pattern |
| `apps/web/src/components/transactions/transaction-form-dialog.tsx` | Income/expense dialog |
| `apps/web/src/components/transactions/transfer-form-dialog.tsx` | Transfer dialog |
| `apps/web/e2e/*.spec.ts` | Playwright E2E coverage |
| `apps/web/.env.local` | `VITE_CONVEX_URL` |

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
   `- settings.tsx
```

### Convex Integration

The frontend connects to Convex via `@convex-dev/react-query`.

- `ConvexQueryClient` is integrated with React Query in `apps/web/src/router.tsx`
- `ConvexAuthProvider` wraps the app so authenticated requests include auth state
- `VITE_CONVEX_URL` comes from `apps/web/.env.local`
- Backend types are imported from `@mpf/backend`

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
- `settings.spec.ts` (the link/unlink test needs `E2E_CONVEX_SITE_URL` and `E2E_FINANCE_API_SERVICE_KEY`)

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

## packages/backend -- Convex Backend

**IMPORTANT:** When working on Convex code, always read `packages/backend/convex/_generated/ai/guidelines.md` first.

**Stack:** Convex with Convex Auth.

### Backend Implementation Patterns

- Amounts are stored in minor units (cents)
- Most modules derive the current user via `getAuthUserId(ctx)` from `@convex-dev/auth/server`
- Never accept `userId` from the client for authorization
- Always include argument validators
- Prefer indexed queries with bounded results (`take(...)`) over unbounded reads
- Ownership checks are required before reading or mutating user-owned documents

### Domain Patterns

- `accounts` store balances directly and are updated by transaction and transfer mutations
- `transactions` represent income, expense, adjustment, and transfer records
- Transfers are modeled as two linked `transactions` documents with a shared `transferGroupId`
- Categories are seeded during onboarding and then customized by the user
- Savings goals live in `savingsGoals`, with contribution history in `goalContributions`
- Onboarding completion is tracked in `userProfiles.onboardingCompleted`

### Key Files

| File | Purpose |
| ---- | ------- |
| `packages/backend/convex/schema.ts` | Full data model |
| `packages/backend/convex/auth.ts` | Convex Auth setup |
| `packages/backend/convex/auth.config.ts` | Auth provider config |
| `packages/backend/convex/http.ts` | Auth HTTP routes |
| `packages/backend/convex/userProfiles.ts` | Profile and onboarding state |
| `packages/backend/convex/accounts.ts` | Accounts CRUD and balance adjustments |
| `packages/backend/convex/categories.ts` | Category seeding and category/subcategory CRUD |
| `packages/backend/convex/transactions.ts` | Transaction CRUD and summaries |
| `packages/backend/convex/transfers.ts` | Paired transfer creation, update, and deletion |
| `packages/backend/convex/savingsGoals.ts` | Savings goal CRUD |
| `packages/backend/convex/goalContributions.ts` | Goal contribution history |
| `packages/backend/convex/channelLinks.ts` | Telegram link codes, linked identities, read-only, unlink |
| `packages/backend/convex/agentStore.ts` | Chat agent state: delete-history button, retention crons (logic in `domain/agentStore.ts`, routes in `api/v1/agent*.ts`) |
| `packages/backend/convex/test.setup.ts` | Shared convex-test helpers |
| `packages/backend/convex/*.test.ts` | Backend unit tests |

### Testing

**Stack:** Vitest + `convex-test` + `@edge-runtime/vm`.

Current backend test coverage includes:

- accounts
- categories
- userProfiles
- transactions
- transfers
- savingsGoals
- goalContributions

#### Test Patterns

- Use a fresh `setupTest()` per test
- Use `asUser(t)` for authenticated scenarios
- Use distinct `subject` values for multi-user isolation tests
- Prefer `toThrow()` in Vitest 4
- Prefer partial assertions like `toMatchObject()` for Convex documents

### Development Workflow -- Test-First

When adding or changing backend functionality:

1. Write or update backend tests first in `packages/backend/convex/*.test.ts`
2. Run the targeted backend tests and confirm they fail when appropriate
3. Implement the Convex changes
4. Re-run `bun run test:once`
5. Typecheck with `bun run typecheck`

## Development Workflow -- Full Feature Lifecycle

For non-trivial product work:

1. Backend first
   - add/update Convex tests
   - implement the Convex API
2. Frontend next
   - add/update routes and components
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

The app is beyond the original auth-only and Phase 1 placeholder state.

**Implemented:**

- Landing page with responsive nav and dark mode
- Email/password auth with Convex Auth
- Onboarding flow for currency, starter accounts, and starter categories
- Persistent authenticated shell with sidebar, sign out, theme toggle, and floating quick actions
- Dashboard with real accounts, transaction summaries, cashflow, category spending, recent transactions, and goals progress
- Accounts management with CRUD, archive/restore, and balance adjustments
- Transactions management for income and expenses with filters
- Transfer support backed by paired transfer transactions
- Categories and subcategories management
- Savings goals CRUD plus contribution history
- Backend tests across the main financial modules
- Playwright coverage for landing, auth, onboarding, accounts, transactions, transfers, and goals

**Partial or not yet wired:**

- Forgot password still needs email infrastructure
- Google OAuth button is present but provider wiring is not done
- Budgets, debts, and settings do not yet have dedicated pages or backend modules
- Some dashboard cards still use mock data for upcoming modules

**Next steps per the PRD:** budgets, debts, recurring transactions, richer settings, and continued dashboard replacement of mock widgets with real data.
