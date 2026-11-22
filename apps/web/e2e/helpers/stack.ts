/** The local stack Playwright starts (playwright.config.ts), as the tests reach it. */

/** The bot username the API is configured with: Settings → Telegram links to it. */
export const E2E_BOT_USERNAME = "dalva_e2e_bot";

/**
 * Calls a service route (the chat agent's own credential) on the test API, as
 * the bot would. The key is made per run in playwright.config.ts.
 */
export async function serviceCall(path: string, body: Record<string, unknown>) {
  const apiUrl = process.env.E2E_API_URL;
  const serviceKey = process.env.E2E_FINANCE_API_SERVICE_KEY;
  if (!apiUrl || !serviceKey) throw new Error("E2E_API_URL and E2E_FINANCE_API_SERVICE_KEY are set by playwright.config.ts");
  const response = await fetch(`${apiUrl}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { ok: boolean } };
}
