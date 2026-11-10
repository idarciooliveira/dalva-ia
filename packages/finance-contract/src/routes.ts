import type { z } from "zod";

import { API_BASE_PATH } from "./envelope";
import * as s from "./schemas";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteDef {
  method: HttpMethod;
  /** Relative to `/api/v1`. `:name` segments are path params and must be keys of `request`. */
  path: string;
  /** Flat input: path params, plus query (GET) or JSON body (writes). */
  request: z.ZodType;
  /** Shape of `data` in the success envelope. */
  response: z.ZodType;
}

const route = <Req extends z.ZodType, Res extends z.ZodType>(
  method: HttpMethod,
  path: string,
  request: Req,
  response: Res,
) => ({ method, path, request, response }) satisfies RouteDef;

/**
 * The /api/v1 route map. Server and client both derive from this object:
 * the server matches + validates with it, the client builds calls and parses
 * responses with it. Add an operation here and it shows up on both sides.
 */
export const routes = {
  accounts: {
    list: route("GET", "/accounts", s.accountsListRequestSchema, s.accountsListResponseSchema),
    get: route("GET", "/accounts/:id", s.accountGetRequestSchema, s.accountGetResponseSchema),
    adjust: route("POST", "/accounts/:id/adjustments", s.accountAdjustRequestSchema, s.accountAdjustResponseSchema),
  },
  categories: {
    list: route("GET", "/categories", s.categoriesListRequestSchema, s.categoriesListResponseSchema),
  },
  subcategories: {
    list: route("GET", "/subcategories", s.subcategoriesListRequestSchema, s.subcategoriesListResponseSchema),
  },
  transactions: {
    search: route("GET", "/transactions", s.transactionsSearchRequestSchema, s.transactionsSearchResponseSchema),
    create: route("POST", "/transactions", s.transactionCreateRequestSchema, s.transactionResponseSchema),
    update: route("PATCH", "/transactions/:id", s.transactionUpdateRequestSchema, s.transactionResponseSchema),
    delete: route("DELETE", "/transactions/:id", s.transactionDeleteRequestSchema, s.transactionDeleteResponseSchema),
  },
  transfers: {
    create: route("POST", "/transfers", s.transferCreateRequestSchema, s.transferResponseSchema),
    update: route("PATCH", "/transfers/:id", s.transferUpdateRequestSchema, s.transferResponseSchema),
    delete: route("DELETE", "/transfers/:id", s.transferDeleteRequestSchema, s.transferDeleteResponseSchema),
  },
  reports: {
    transactionSummary: route(
      "GET",
      "/reports/transaction-summary",
      s.transactionSummaryRequestSchema,
      s.transactionSummaryResponseSchema,
    ),
    spendingByCategory: route(
      "GET",
      "/reports/spending-by-category",
      s.spendingByCategoryRequestSchema,
      s.spendingByCategoryResponseSchema,
    ),
    cashflow: route("GET", "/reports/cashflow", s.cashflowRequestSchema, s.cashflowResponseSchema),
    netWorth: route("GET", "/reports/net-worth", s.netWorthRequestSchema, s.netWorthResponseSchema),
    debtSummary: route("GET", "/reports/debt-summary", s.debtSummaryRequestSchema, s.debtSummaryResponseSchema),
  },
  goals: {
    list: route("GET", "/goals", s.goalsListRequestSchema, s.goalsListResponseSchema),
    get: route("GET", "/goals/:id", s.goalGetRequestSchema, s.goalGetResponseSchema),
  },
  goalContributions: {
    list: route(
      "GET",
      "/goals/:goalId/contributions",
      s.goalContributionsListRequestSchema,
      s.goalContributionsListResponseSchema,
    ),
    add: route(
      "POST",
      "/goals/:goalId/contributions",
      s.goalContributionAddRequestSchema,
      s.goalContributionAddResponseSchema,
    ),
    remove: route(
      "DELETE",
      "/goal-contributions/:id",
      s.goalContributionRemoveRequestSchema,
      s.goalContributionRemoveResponseSchema,
    ),
  },
  debts: {
    list: route("GET", "/debts", s.debtsListRequestSchema, s.debtsListResponseSchema),
    get: route("GET", "/debts/:id", s.debtGetRequestSchema, s.debtGetResponseSchema),
  },
  debtPayments: {
    list: route("GET", "/debts/:debtId/payments", s.debtPaymentsListRequestSchema, s.debtPaymentsListResponseSchema),
    record: route(
      "POST",
      "/debts/:debtId/payments",
      s.debtPaymentRecordRequestSchema,
      s.debtPaymentRecordResponseSchema,
    ),
    remove: route(
      "DELETE",
      "/debt-payments/:id",
      s.debtPaymentRemoveRequestSchema,
      s.debtPaymentRemoveResponseSchema,
    ),
  },
} as const satisfies Record<string, Record<string, RouteDef>>;

export type Routes = typeof routes;
export type RouteInput<R extends RouteDef> = z.input<R["request"]>;
export type RouteParsedInput<R extends RouteDef> = z.output<R["request"]>;
export type RouteOutput<R extends RouteDef> = z.output<R["response"]>;

/** Writes (everything except GET) require an `Idempotency-Key` header. */
export function isWriteRoute(route: Pick<RouteDef, "method">): boolean {
  return route.method !== "GET";
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
}

export interface NamedRoute {
  group: string;
  op: string;
  /** `group.op`, e.g. `transactions.search`. */
  name: string;
  route: RouteDef;
}

export function allRoutes(): NamedRoute[] {
  return Object.entries(routes).flatMap(([group, ops]) =>
    Object.entries(ops as Record<string, RouteDef>).map(([op, route]) => ({
      group,
      op,
      name: `${group}.${op}`,
      route,
    })),
  );
}

export interface RouteMatch extends NamedRoute {
  params: Record<string, string>;
}

/** Resolve an incoming request (method + full pathname incl. `/api/v1`) to a route. */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  if (pathname !== API_BASE_PATH && !pathname.startsWith(`${API_BASE_PATH}/`)) return null;
  const actual = pathname.slice(API_BASE_PATH.length).split("/").filter(Boolean);

  for (const named of allRoutes()) {
    if (named.route.method !== method) continue;
    const template = named.route.path.split("/").filter(Boolean);
    if (template.length !== actual.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (const [i, segment] of template.entries()) {
      const value = actual[i]!;
      if (segment.startsWith(":")) {
        try {
          params[segment.slice(1)] = decodeURIComponent(value);
        } catch {
          matched = false;
          break;
        }
      } else if (segment !== value) {
        matched = false;
        break;
      }
    }
    if (matched) return { ...named, params };
  }
  return null;
}

/**
 * Server side: build the flat input a route's `request` schema expects from
 * the matched path params plus the query string (GET) or JSON body (writes).
 * Path params always win over same-named query/body keys.
 */
export function mergeRequestInput(
  match: Pick<RouteMatch, "route" | "params">,
  source: URLSearchParams | Record<string, unknown> | undefined,
): Record<string, unknown> {
  const fromSource =
    source instanceof URLSearchParams ? Object.fromEntries(source) : (source ?? {});
  return { ...fromSource, ...match.params };
}

export interface RequestParts {
  /** Path relative to `/api/v1`, params substituted and encoded. */
  path: string;
  /** Encoded query string without `?` (GET only). */
  query: string;
  /** JSON body (writes with at least one non-path field). */
  body: Record<string, unknown> | undefined;
}

/** Client side: split a flat input into path, query and body for a route. */
export function buildRequestParts(route: RouteDef, input: Record<string, unknown>): RequestParts {
  const names = new Set(pathParamNames(route.path));
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(input[name])));
  const rest = Object.entries(input).filter(([key, value]) => !names.has(key) && value !== undefined);

  if (route.method === "GET") {
    return { path, query: new URLSearchParams(rest.map(([k, v]) => [k, String(v)])).toString(), body: undefined };
  }
  return { path, query: "", body: rest.length > 0 ? Object.fromEntries(rest) : undefined };
}
