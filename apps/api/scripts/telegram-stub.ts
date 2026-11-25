/**
 * A stand-in for the Telegram Bot API (`TELEGRAM_API_URL`), for the E2E API.
 * Every well-formed token is a bot named `username`, except tokens whose
 * secret starts with "rejected", which get Telegram's 401 "Unauthorized".
 * Webhooks are kept per token in memory; `getUpdates` never has any.
 */
export function startTelegramStub(options: { username: string; port?: number }) {
  const webhooks = new Map<string, string>();
  const ok = (result: unknown) => Response.json({ ok: true, result });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const match = /^\/bot(\d+):([A-Za-z0-9_-]+)\/(\w+)$/.exec(new URL(request.url).pathname);
      if (!match) return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      const [, id, secret, method] = match as unknown as [string, string, string, string];
      if (secret.startsWith("rejected")) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      const token = `${id}:${secret}`;
      const body = (await request.json().catch(() => ({}))) as { url?: string };
      switch (method) {
        case "getMe":
          return ok({ id: Number(id), is_bot: true, first_name: "DALVA", username: options.username });
        case "setWebhook":
          webhooks.set(token, body.url ?? "");
          return ok(true);
        case "deleteWebhook":
          webhooks.delete(token);
          return ok(true);
        case "getUpdates":
          // A short long-poll, so a polling dev agent idles instead of spinning.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return ok([]);
        case "getWebhookInfo":
          return ok({ url: webhooks.get(token) ?? "", pending_update_count: 0 });
        default:
          return Response.json({ ok: false, error_code: 404, description: "Not Found: method not found" }, { status: 404 });
      }
    },
  });
}
