# Deploy

The whole app runs from one compose stack on the VPS: web (Caddy + SPA), API, agent, Postgres, nightly backup. No published ports: Dokploy's Traefik routes the domain to `web`, behind Cloudflare.

```text
Cloudflare -> Dokploy Traefik -> web:8080 (Caddy, single entry)
                                             ├─ /api/auth/*, /api/trpc/*  -> api:4000 -> postgres
                                             ├─ /webhooks/telegram      -> agent:3000 -> api:4000
                                             └─ everything else         -> SPA (fallback to the shell)
migrate (one-shot, before api) -> postgres     backup (daily pg_dump) -> postgres
```

Files, from the repo root: `compose.yml`, `.env.example`, `deploy/smoke.sh`. Compose builds the images from the repo's Dockerfiles; nothing is pulled from a registry except Postgres.

Only the agent and the API reach the internet (Telegram, the model provider; the API only calls Telegram when the owner saves the bot). Postgres and backup sit on internal networks; `web` joins Dokploy's `dokploy-network` so Traefik can reach it. Every service runs read-only, with no capabilities, `no-new-privileges`, CPU and memory limits and rotated logs; the long-running ones have healthchecks. `postgres` runs as its own user, API, web and agent as 65532, `backup` as root without capabilities.

## Images

`docker compose build` (or `up --build`) builds them on the host from `apps/*/Dockerfile`.

- api (`apps/api/Dockerfile`, also used by `migrate`): bundled server plus the migration runner and `apps/api/drizzle`. `bun main.js` serves; `bun src/db/migrate.js` migrates and exits.
- web (`apps/web/Dockerfile`): the SPA built with Bun, served by Caddy (`apps/web/Caddyfile`). No build-time settings: the bot username comes from the instance settings, through the API.
- agent (`apps/agent/Dockerfile`).

`.github/workflows/stack.yml` runs on pull requests that touch `compose.yml`, `deploy/**`, a Dockerfile, the Caddyfile or migrations: it builds the images with compose, starts the stack on an empty database and runs `deploy/smoke.sh`.

## Secrets and settings

Four values in the stack's environment (Dokploy: Environment tab; by hand: `.env` in the repo root, a copy of `.env.example`, the same file local dev uses). Compose uses them for interpolation; each service gets only its own variables, so the agent never sees `BETTER_AUTH_SECRET`.

Generate secrets with `openssl rand -hex 32`. Hex matters: the Postgres password goes into a URL. Every secret must differ from the others.

| Var | |
| --- | --- |
| `POSTGRES_PASSWORD` | Generate. Only read when the volume is first created; changing it later needs `ALTER ROLE` too. |
| `PUBLIC_URL` | `https://<hostname>`, no path, the same as the Dokploy domain. Web, API and webhook share it. |
| `BETTER_AUTH_SECRET` | Generate. Signs session cookies and, derived from it, the agent's user tokens and the key that encrypts the bot token and AI key in the database. Changing it signs everyone out and makes those two unreadable: Settings says so and the owner enters them again. |
| `FINANCE_API_SERVICE_KEY` | Generate. The agent's service key; compose gives the same value to API and agent. |

Optional: `COMPOSE_PROJECT_NAME` (a second stack on the same host, e.g. `dalva-staging`).

Fixed in `compose.yml`, not settings: database and role name (`dalva`), `NODE_ENV=production`, `CLIENT_IP_HEADER=cf-connecting-ip`, the Postgres image version, and the backup (daily 03:00 UTC, 14 days). The agent's tuning (session idle, rate limit, step and timeout limits, time zone) and the log levels keep their defaults in code. The API and the agent validate their env at boot and exit naming the bad variable, never the value. `FINANCE_API_URL` is fixed to `http://api:4000` by compose.

### In the app: bot and AI provider

The first user to sign up owns the instance (existing databases: the earliest user). Only the owner sees Settings → Assistant setup, where they set:

- **Telegram bot**: the BotFather token. The API checks it (`getMe`, which gives the username), generates a webhook secret, calls `setWebhook` (`<PUBLIC_URL>/webhooks/telegram`, `message` + `callback_query`) and shows Telegram's error if it refuses. The page shows the webhook status (`getWebhookInfo`: URL, pending updates, last error) and removes the bot (`deleteWebhook`, then forgets it).
- **AI provider**: `gateway` (Vercel AI Gateway) or `openrouter`, a model id, the key.

Screenshots: [empty](screenshots/assistant-setup-empty.png), [configured](screenshots/assistant-setup-configured.png), [Telegram error](screenshots/assistant-setup-telegram-error.png), [other users](screenshots/settings-non-owner.png).

Secrets are write-only: stored encrypted (key derived from `BETTER_AUTH_SECRET`), never sent back to the browser, only their last 4 characters. The agent reads them from the API with its service key and re-reads every 15s (sooner when a webhook carries an unknown secret), so a change applies without a restart. Until a bot is saved, the agent stays healthy and the webhook answers 503.

## First deploy

Steps for a staging stack next to production on the same VPS. Production uses the same steps with the production hostname and the production bot.

1. **Bot.** Create a second bot in BotFather for staging. A bot has one webhook: saving the production bot on staging takes it from production.
2. **Domain.** In Dokploy, create the compose service from this repo (compose path `./compose.yml`) and add a domain: `staging.dalva.example.com`, service `web`, port `8080`, no path. Point it at Cloudflare as usual. Caddy decides what is reachable; the agent's and API's `/health` are not routed.
3. **WAF.** Telegram must reach `/webhooks/telegram` on that hostname: no Cloudflare Access on it, and skip Bot Fight / Super Bot Fight Mode for that path (details in [Let Telegram through](#let-telegram-through)).
4. **Stack.** On the VPS:
   ```bash
   git clone <repo> dalva-staging && cd dalva-staging   # the build needs the whole repo
   cp .env.example .env        # production section: COMPOSE_PROJECT_NAME=dalva-staging, PUBLIC_URL=https://staging.dalva.example.com, secrets
   docker compose up -d --build
   docker compose ps           # migrate: Exited (0); the rest healthy
   ```
   In Dokploy the stack is the compose service: set the environment, then Deploy. `dokploy-network` already exists there; on a plain host create it with `docker network create dokploy-network`.
5. **Owner.** Sign up in the browser before anyone else: the first user owns the instance. Finish onboarding.
6. **Bot and AI.** Settings → Assistant setup: paste the staging bot's token (the webhook is set for you; the delivery status should show this hostname and no error), then the AI provider, model and key.
7. **Smoke test.** `deploy/smoke.sh` from the repo root: health, routing, the agent's settings, sign-up and sign-in through Caddy, a backup and a restore into a scratch database (dropped after). It leaves one `smoke-*@example.com` user and refuses to run on an empty database, where that user would become the owner.
8. **Check from outside.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://staging.dalva.example.com/                        # 200
   curl -s -o /dev/null -w '%{http_code}\n' https://staging.dalva.example.com/api/trpc/accounts.list   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://staging.dalva.example.com/webhooks/telegram  # 401 (503 without a bot)
   ```
   Then link Telegram from Settings with the staging bot.

## Updates

```bash
cd dalva                     # the repo root, where compose.yml and .env are
git pull
docker compose up -d --build
```

Stacks set up from `deploy/docker-compose.yml`: that file is now `compose.yml` in the repo root. In Dokploy, change the compose path to `./compose.yml` before the next deploy; the Environment tab stays as it is. By hand: move `deploy/.env` to the repo root and run compose from there.

`migrate` runs on every `up` and the API waits for it, so a new API never starts on an old schema. Migrations are forward-only: checking out an older commit does not roll the schema back. Before an update that carries a migration, take a backup (`docker compose run --rm backup now`).

Roll back by checking out the previous commit and running `up -d --build`, as long as no migration in between removed something the old code needs.

## Backup and restore

The `backup` service dumps the database daily at 03:00 (UTC) into the `backups` volume as `<db>-YYYYmmdd-HHMMSS.dump` (`pg_dump --format=custom`) and deletes dumps more than 14 full days old (`find -mtime +N`: 14 keeps 15 dailies). The volume is on the same host: copy dumps off it regularly.

```bash
docker compose run --rm backup now                       # dump now
docker compose run --rm backup list                      # what is on disk
docker run --rm -v dalva_backups:/b -v "$PWD":/out alpine cp /b/<file> /out/   # copy one off the volume (<project>_backups)
```

Restore always goes into a new database; it refuses one that exists. Volume names carry the compose project prefix (`docker volume ls`): `dalva_backups` in a plain stack, `dalva-staging_backups` on staging, and whatever name Dokploy gave the project in Dokploy.

Check a dump (what CI does):

```bash
docker compose run --rm backup restore <file> restore_check
docker compose exec postgres psql -U dalva -d restore_check -c 'select count(*) from users'
docker compose exec postgres psql -U dalva -d dalva -c 'drop database restore_check'
```

Replace the live database:

```bash
docker compose run --rm backup now                       # keep what is there now
docker compose stop api agent web
docker compose exec postgres psql -U dalva -d postgres -c 'drop database dalva'
docker compose run --rm backup restore <file> dalva
docker compose up -d
```

A dump from another host: copy it into the volume (`docker run --rm -v dalva_backups:/b -v "$PWD":/in alpine cp /in/<file> /b/`), then restore as above.

## Logs

```bash
docker compose logs -f --tail 100 api agent
docker compose logs --no-log-prefix api 2>&1 | jq -R 'fromjson? | select(.level=="error" or .level=="warn")'
```

API, agent, migrate and backup log JSON lines without secrets. Rotation: 5 files of 10 MB per container.

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `up` stops with `set POSTGRES_PASSWORD` (or another name) | Missing in `.env`. |
| `migrate` exits 1, API never starts | `docker compose logs migrate`. Fix and `up -d` again. |
| API restarts with `Invalid environment: ...` | The message names the variable: placeholder secret, http `PUBLIC_URL` in production, equal secrets. |
| Postgres `password authentication failed` after changing `POSTGRES_PASSWORD` | The password is set only when the volume is created. `ALTER ROLE dalva PASSWORD '...'` or restore into a new volume. |
| Cloudflare `502`/`530`, or Traefik `404` | The Dokploy domain doesn't point at service `web` port `8080`, or `web` is unhealthy. `docker compose ps`. |
| Sign-in works but the app shows signed out | `PUBLIC_URL` differs from the hostname in the browser: the cookie is `Secure` and bound to that origin. |
| Settings: "Telegram refused the webhook" | `PUBLIC_URL` isn't reachable over https from Telegram, or its certificate is invalid. |
| Settings: token or key "can't be read" | `BETTER_AUTH_SECRET` changed. Enter the token and key again. |
| Webhook `503` `telegram not configured` | No bot saved yet, or it was removed. Settings → Assistant setup. |
| Delivery status shows `401` errors | The webhook secret changed under the agent (another stack saved the same bot). Save the bot again here. |
| Delivery status shows `403`, nothing in agent logs | Cloudflare blocks Telegram. See [Let Telegram through](#let-telegram-through). |

## Let Telegram through

Telegram calls from datacenter IPs with no browser. Bot Fight Mode, Super Bot Fight Mode and a strict WAF can block it, and the failure is silent on your side.

- Don't put Cloudflare Access in front of this hostname.
- Super Bot Fight Mode (Pro and up): Security → WAF → Custom rules → hostname equals `dalva.example.com` and path equals `/webhooks/telegram` → action **Skip** → Super Bot Fight Mode rules (plus any managed rules that block it).
- Bot Fight Mode (Free) can't be skipped by a rule. If the delivery status in Settings shows 403s, turn it off for the zone or serve the app from a zone where it is off.
- Check Security → Events for blocks on that path.

### Optional: only Telegram's IPs

Custom rule, action **Block**: hostname equals `dalva.example.com` and path equals `/webhooks/telegram` and `ip.src` not in `{149.154.160.0/20 91.108.4.0/22}`. Confirm the ranges at <https://core.telegram.org/bots/webhooks> first. The secret header is the real auth; this only cuts noise.
