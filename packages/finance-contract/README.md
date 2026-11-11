# @mpf/finance-contract

Backend-agnostic contract for the versioned Finance API (`/api/v1`): zod schemas, shared primitives, the route map and a typed fetch client. No Convex imports, no Node-only APIs (runs on Bun, the Convex runtime and the browser).

```ts
import { createFinanceClient } from "@mpf/finance-contract";

const finance = createFinanceClient({ baseUrl: "https://api.example.com", getToken: () => token });
const { items, nextCursor } = await finance.transactions.search({ accountId, limit: 20 });
await finance.transactions.create({ type: "expense", amount: moneyFromDecimal("12.50", "USD"), accountId, date: "2026-04-05" });
```

Service routes (channel linking, used by the chat agent) have their own client, authenticated with the service key:

```ts
import { createFinanceServiceClient } from "@mpf/finance-contract";

const service = createFinanceServiceClient({ baseUrl, getServiceKey: () => process.env.FINANCE_API_SERVICE_KEY! });
await service.channelLinks.redeem({ channel: "telegram", code, externalUserId, chatId, username });
const { token, profile } = await service.channelIdentities.resolve({ channel: "telegram", externalUserId, chatId });
const finance = createFinanceClient({ baseUrl, getToken: () => token });
```

## Conventions

- Every route has `auth: "user" | "service"`. User routes take a user token; service routes take the service key. The router rejects the wrong credential with `unauthorized`, and each client only exposes its own routes. Service routes take no `Idempotency-Key`.
- User routes: `Authorization: Bearer <user-scoped token>` on every call. `Idempotency-Key` on every write (POST/PATCH/DELETE); the client generates one unless given, and puts it on `FinanceApiError.idempotencyKey` (also for `aborted`, `timeout` and `network_error`, which the client reports as separate codes; the caught error is kept as `cause` and never mutated) so an ambiguous write can be retried with the same key.
- Success: `{ ok: true, data }`. Error: `{ ok: false, error: { code, message, details? } }` with codes `unauthorized | forbidden | not_found | validation_failed | conflict | rate_limited | internal` (HTTP statuses in `ERROR_STATUS`).
- Amounts are `{ amountMinor, currency }`: an integer in the ISO 4217 minor unit (JPY 0 decimals, USD 2, KWD 3). Convert with `parseDecimalAmount` / `formatMinorAmount`; both are BigInt/string based.
- Branded ids (`AccountId`, ...) are an output-side type: call inputs accept plain strings and are validated at runtime (URL-safe `[A-Za-z0-9_-]`).
- Requests are strict (unknown keys fail). Responses tolerate extra fields so the API can grow without breaking old clients.
- Adding an operation: add schemas in `schemas.ts` and a line in `routes.ts` (`route` for user, `serviceRoute` for service; one auth kind per group). The client method, route matching and typing follow.

## Server obligations (PR 3)

Things the schemas can't express, or that the current domain layer doesn't do yet:

- **Minor units.** The web app stores and formats every currency as value × 100 (`formatCurrency`, `currency-input`, onboarding). That matches ISO only for 2-decimal currencies. For JPY/KWD-style currencies, either fix the app to use `currencyExponent` or scale at the API boundary; don't mix them.
- **Currency.** Domain numbers carry no currency. Fill `Money.currency` from the account for account-scoped data and from `userProfiles.baseCurrency` for goals, debts and reports. Reject a request currency that differs from the account's (`validation_failed`) and reject cross-currency transfers. `getDebtSummary` hardcodes `"USD"` and `getNetWorth` uses `accounts[0]`.
- **Mixed currencies.** There is no FX: a report or summary that would aggregate amounts outside the base currency returns `conflict` ("Reports across multiple currencies are not supported yet", `details: { reason: "mixed_currencies", currencies }`), never an unconverted total. Rows of a deleted account have no known currency: `conflict` with `reason: "unknown_currency"`.
- **`transactions.search`.** `listTransactions` reads the newest 200 rows and filters in memory: no `q`, no cursor, `limit` capped at 50. Needs an indexed query with a real cursor before `nextCursor`/`q` are honest.
- **`reports.cashflow`.** The domain returns `trend[].month` as a label (`"Jan"`); the contract wants `YYYY-MM`. Derive it from the requested month (consecutive months, oldest first).
- **Managed rows.** Transfer legs, goal-contribution transfers and debt-payment transactions appear in searches. `transactions.update` / `transactions.delete` on them must return `conflict`; `deleteTransaction` currently treats a transfer leg as a credit and orphans the other leg.
- **Sign rule.** Income/expense amounts are positive, adjustments signed. `updateTransaction` and `createTransaction` don't check; enforce against the effective type.
- **Errors.** Domain errors are plain `Error` messages. Map them to `not_found` / `validation_failed` / `conflict` explicitly, and treat a malformed id as `validation_failed`.
- **Writes return the entity.** `adjustBalance`, `addContribution`, `recordDebtPayment` and the transfer functions return ids or nothing; re-read to build `{ account }`, `{ contribution }`, `{ payment }`, `{ transfer }`.
- **Idempotency.** Store `(user, key) -> response`; same key + different body is `conflict`.
- **Dates.** `accounts.adjust` defaults `date` to the server's UTC date.
