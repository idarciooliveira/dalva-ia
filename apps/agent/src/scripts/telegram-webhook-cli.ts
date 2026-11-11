import { runWebhookCommand } from "./telegram-webhook";

// Bun loads apps/agent/.env on its own. Usage: bun run telegram:webhook:<set|info|delete>
process.exit(await runWebhookCommand(process.argv[2], process.env));
