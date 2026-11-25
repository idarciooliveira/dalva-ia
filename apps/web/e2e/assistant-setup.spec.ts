import { expect, test, type Page } from "@playwright/test";

import { logIn, registerAndCompleteOnboarding } from "./helpers/auth";
import { E2E_BOT_USERNAME, E2E_OWNER, REJECTED_TOKEN, stubToken } from "./helpers/stack";

/** Settings → Assistant setup: the instance owner's Telegram bot and AI provider. Telegram is the API's stub. */

async function openAsOwner(page: Page) {
  await logIn(page, E2E_OWNER);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Assistant setup" })).toBeVisible();
}

test("a user who doesn't own the instance never sees the assistant setup", async ({ page }) => {
  await registerAndCompleteOnboarding(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Telegram" })).toBeVisible();
  // The link flow still works: the owner's bot is named.
  await expect(page.getByRole("button", { name: "Connect Telegram" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Assistant setup" })).toHaveCount(0);
  await expect(page.getByText("Telegram bot", { exact: true })).toHaveCount(0);
  await expect(page.getByText("AI provider", { exact: true })).toHaveCount(0);
});

test.describe("as the instance owner", () => {
  // One owner and one settings row for the whole run: these change what every test sees, so one
  // browser project runs them, one at a time.
  test.describe.configure({ mode: "serial" });
  test.skip(({ browserName }) => browserName !== "chromium", "instance-wide settings: one project runs them");

  test("shows the configured bot and its delivery status", async ({ page }) => {
    await openAsOwner(page);
    const bot = page.getByTestId("telegram-bot-settings");
    await expect(bot).toContainText(`@${E2E_BOT_USERNAME}`);
    await expect(bot).toContainText(/token …\w{4}/);
    // PUBLIC_URL is http here: the agent polls, no webhook is set.
    await expect(bot.getByText("Polling (local dev)")).toBeVisible();
    await expect(page.getByTestId("telegram-webhook-status")).toContainText("none (the agent polls)");
    await expect(page.getByTestId("telegram-webhook-status")).toContainText(/Pending updates\s*0/);
  });

  test("shows Telegram's refusal in the form and keeps the current bot", async ({ page }) => {
    await openAsOwner(page);
    await page.getByRole("button", { name: /replace bot|set up bot|enter token/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bot token").fill(REJECTED_TOKEN);
    await dialog.getByRole("button", { name: "Save bot" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Telegram rejected this token. Copy it again from @BotFather.");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("telegram-bot-settings")).toContainText(`@${E2E_BOT_USERNAME}`);
  });

  test("validates the token's shape before calling Telegram", async ({ page }) => {
    await openAsOwner(page);
    await page.getByRole("button", { name: /replace bot|set up bot|enter token/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Bot token").fill("not a token");
    await dialog.getByRole("button", { name: "Save bot" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Paste the token from @BotFather");
  });

  test("saves a new bot; the token is never rendered back", async ({ page }) => {
    const token = stubToken(300000003);
    await openAsOwner(page);
    await page.getByRole("button", { name: /replace bot|set up bot|enter token/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Bot token")).toHaveAttribute("type", "password");
    await dialog.getByLabel("Bot token").fill(token);
    await dialog.getByRole("button", { name: "Save bot" }).click();
    await expect(dialog).toBeHidden();

    const bot = page.getByTestId("telegram-bot-settings");
    await expect(bot).toContainText("token …0003");
    expect(await page.content()).not.toContain(token.split(":")[1]);
    await page.reload();
    await expect(page.getByTestId("telegram-bot-settings")).toContainText("token …0003");
    expect(await page.content()).not.toContain(token.split(":")[1]);
    // Reopened, the field is empty: the token never comes back from the API.
    await page.getByRole("button", { name: "Replace bot" }).click();
    await expect(page.getByRole("dialog").getByLabel("Bot token")).toHaveValue("");
  });

  test("saves the AI provider; the key is write-only", async ({ page }) => {
    const key = "sk-e2e-key-0123456789abcdef";
    await openAsOwner(page);
    await page.getByRole("button", { name: /set up ai provider|change ai provider|enter key/i }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "OpenRouter" }).click();
    await dialog.getByLabel("Model").fill("vendor/model-e2e");
    await dialog.getByLabel("API key").fill(key);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    const ai = page.getByTestId("ai-provider-settings");
    await expect(ai).toContainText("OpenRouter");
    await expect(ai).toContainText("vendor/model-e2e");
    await expect(ai).toContainText("key …cdef");
    expect(await page.content()).not.toContain(key);

    // Change the model only: the stored key stays.
    await page.getByRole("button", { name: "Change AI provider" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await expect(dialog.getByLabel("API key")).toHaveAttribute("placeholder", "Keep the current key (…cdef)");
    await dialog.getByLabel("Model").fill("vendor/model-e2e-2");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(ai).toContainText("vendor/model-e2e-2");
    await expect(ai).toContainText("key …cdef");
  });
});
