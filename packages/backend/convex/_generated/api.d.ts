/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as api_v1_accounts from "../api/v1/accounts.js";
import type * as api_v1_categories from "../api/v1/categories.js";
import type * as api_v1_debts from "../api/v1/debts.js";
import type * as api_v1_define from "../api/v1/define.js";
import type * as api_v1_errors from "../api/v1/errors.js";
import type * as api_v1_goals from "../api/v1/goals.js";
import type * as api_v1_idempotency from "../api/v1/idempotency.js";
import type * as api_v1_money from "../api/v1/money.js";
import type * as api_v1_registry from "../api/v1/registry.js";
import type * as api_v1_reports from "../api/v1/reports.js";
import type * as api_v1_router from "../api/v1/router.js";
import type * as api_v1_shared from "../api/v1/shared.js";
import type * as api_v1_tokens from "../api/v1/tokens.js";
import type * as api_v1_transactions from "../api/v1/transactions.js";
import type * as api_v1_transfers from "../api/v1/transfers.js";
import type * as auth from "../auth.js";
import type * as categories from "../categories.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as debtPayments from "../debtPayments.js";
import type * as debts from "../debts.js";
import type * as domain_accounts from "../domain/accounts.js";
import type * as domain_categories from "../domain/categories.js";
import type * as domain_dashboard from "../domain/dashboard.js";
import type * as domain_debtPayments from "../domain/debtPayments.js";
import type * as domain_debts from "../domain/debts.js";
import type * as domain_goalContributions from "../domain/goalContributions.js";
import type * as domain_savingsGoals from "../domain/savingsGoals.js";
import type * as domain_transactions from "../domain/transactions.js";
import type * as domain_transfers from "../domain/transfers.js";
import type * as domain_userProfiles from "../domain/userProfiles.js";
import type * as goalContributions from "../goalContributions.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as savingsGoals from "../savingsGoals.js";
import type * as transactions from "../transactions.js";
import type * as transfers from "../transfers.js";
import type * as userProfiles from "../userProfiles.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  "api/v1/accounts": typeof api_v1_accounts;
  "api/v1/categories": typeof api_v1_categories;
  "api/v1/debts": typeof api_v1_debts;
  "api/v1/define": typeof api_v1_define;
  "api/v1/errors": typeof api_v1_errors;
  "api/v1/goals": typeof api_v1_goals;
  "api/v1/idempotency": typeof api_v1_idempotency;
  "api/v1/money": typeof api_v1_money;
  "api/v1/registry": typeof api_v1_registry;
  "api/v1/reports": typeof api_v1_reports;
  "api/v1/router": typeof api_v1_router;
  "api/v1/shared": typeof api_v1_shared;
  "api/v1/tokens": typeof api_v1_tokens;
  "api/v1/transactions": typeof api_v1_transactions;
  "api/v1/transfers": typeof api_v1_transfers;
  auth: typeof auth;
  categories: typeof categories;
  crons: typeof crons;
  dashboard: typeof dashboard;
  debtPayments: typeof debtPayments;
  debts: typeof debts;
  "domain/accounts": typeof domain_accounts;
  "domain/categories": typeof domain_categories;
  "domain/dashboard": typeof domain_dashboard;
  "domain/debtPayments": typeof domain_debtPayments;
  "domain/debts": typeof domain_debts;
  "domain/goalContributions": typeof domain_goalContributions;
  "domain/savingsGoals": typeof domain_savingsGoals;
  "domain/transactions": typeof domain_transactions;
  "domain/transfers": typeof domain_transfers;
  "domain/userProfiles": typeof domain_userProfiles;
  goalContributions: typeof goalContributions;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  savingsGoals: typeof savingsGoals;
  transactions: typeof transactions;
  transfers: typeof transfers;
  userProfiles: typeof userProfiles;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
