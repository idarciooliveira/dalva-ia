import { expect, type Page } from "@playwright/test";

/** Local "YYYY-MM-DD", as the app's date pickers default to. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An account row on /accounts, by its exact name. */
export function accountRow(page: Page, name: string) {
  return page.getByRole("listitem", { name, exact: true });
}

/** The answer of a tRPC call: its data, or the error's message and code. */
async function answer<T>(response: { json(): Promise<unknown> }, what: string): Promise<T> {
  const json = (await response.json()) as { result?: { data: T }; error?: unknown };
  expect(json.error, `${what}: ${JSON.stringify(json.error)}`).toBeUndefined();
  return json.result!.data;
}

/**
 * Seeds data straight through the API (`/api/trpc`) with the page's session
 * cookie, for records whose own pages are out of scope of a test (goals,
 * debts, extra accounts).
 */
export async function apiWrite<T = Record<string, unknown>>(page: Page, procedure: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/trpc/${procedure}`, {
    headers: { "Idempotency-Key": `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    data: input,
  });
  return await answer<T>(response, procedure);
}

export async function apiGet<T = Record<string, unknown>>(page: Page, procedure: string, input?: unknown): Promise<T> {
  const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  return await answer<T>(await page.request.get(`/api/trpc/${procedure}${query}`), procedure);
}

export const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

export async function createAccount(page: Page, name: string, amountMinor = 0): Promise<string> {
  const { account } = await apiWrite<{ account: { id: string } }>(page, "accounts.create", {
    name,
    type: "bank",
    balance: usd(amountMinor),
  });
  return account.id;
}

/** The id of the onboarding account by name. */
export async function accountId(page: Page, name: string): Promise<string> {
  const { items } = await apiGet<{ items: Array<{ id: string; name: string }> }>(page, "accounts.list", {});
  const found = items.find((a) => a.name === name);
  expect(found, `account ${name}`).toBeDefined();
  return found!.id;
}

