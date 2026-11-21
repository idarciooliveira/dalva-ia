import { createFinanceClient } from "@mpf/finance-contract";

/**
 * The `/api/v1` contract client. Same origin as the page (the Vite proxy in dev,
 * the reverse proxy in production), authenticated by the Better Auth session
 * cookie: no bearer token, so `getToken` is omitted.
 */
export const api = createFinanceClient({ baseUrl: "" });
