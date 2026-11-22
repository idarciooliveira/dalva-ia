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

/**
 * Seeds data straight through `/api/v1` with the page's session cookie, for
 * records whose own pages are out of scope of a test (goals, debts, extra accounts).
 */
export async function apiWrite<T = Record<string, unknown>>(
  page: Page,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
): Promise<T> {
  const response = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { "Idempotency-Key": `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    data: body,
  });
  const json = (await response.json()) as { ok: boolean; data: T };
  expect(json.ok, `${method} ${path}: ${JSON.stringify(json)}`).toBe(true);
  return json.data;
}

export async function apiGet<T = Record<string, unknown>>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`);
  const json = (await response.json()) as { ok: boolean; data: T };
  expect(json.ok, `GET ${path}: ${JSON.stringify(json)}`).toBe(true);
  return json.data;
}

export const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

export async function createAccount(page: Page, name: string, amountMinor = 0): Promise<string> {
  const { account } = await apiWrite<{ account: { id: string } }>(page, "POST", "/accounts", {
    name,
    type: "bank",
    balance: usd(amountMinor),
  });
  return account.id;
}

/** The id of the onboarding account by name. */
export async function accountId(page: Page, name: string): Promise<string> {
  const { items } = await apiGet<{ items: Array<{ id: string; name: string }> }>(page, "/accounts");
  const found = items.find((a) => a.name === name);
  expect(found, `account ${name}`).toBeDefined();
  return found!.id;
}

