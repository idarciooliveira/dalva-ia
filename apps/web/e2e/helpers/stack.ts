/** The local stack Playwright starts (playwright.config.ts), as the tests reach it. */

/** The bot username the Telegram stub answers with, for any token: Settings → Telegram links to it. */
export const E2E_BOT_USERNAME = "dalva_e2e_bot";

/**
 * The instance owner, signed up by the API before it serves (apps/api/scripts/e2e-server.ts),
 * onboarded, with a bot configured. Only it sees Settings → Assistant setup.
 */
export const E2E_OWNER = { name: "Owner", email: "owner@e2e.test", password: "owner-password-123" };

/** A token the Telegram stub accepts (any bot id), and one it refuses with 401. */
export const stubToken = (botId: number) => `${botId}:${"A".repeat(31)}${String(botId).slice(-4).padStart(4, "0")}`;
export const REJECTED_TOKEN = `200000002:rejected${"x".repeat(27)}`;

/**
 * Calls a service procedure (the chat agent's own credential) on the test API,
 * as the bot would. The key is made per run in playwright.config.ts.
 */
export async function serviceCall(procedure: string, input: Record<string, unknown>) {
  const apiUrl = process.env.E2E_API_URL;
  const serviceKey = process.env.E2E_FINANCE_API_SERVICE_KEY;
  if (!apiUrl || !serviceKey) throw new Error("E2E_API_URL and E2E_FINANCE_API_SERVICE_KEY are set by playwright.config.ts");
  const response = await fetch(`${apiUrl}/api/trpc/${procedure}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
