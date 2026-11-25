# Deploy

The whole app runs from one compose stack on the VPS: web (Caddy + SPA), API, agent, Postgres, nightly backup. No published ports: Dokploy's Traefik routes the domain to `web`, behind Cloudflare.

```text
Cloudflare -> Dokploy Traefik -> web:8080 (Caddy, single entry)
                                             ├─ /api/auth/*, /api/trpc/*  -> api:4000 -> postgres
                                             ├─ /webhooks/telegram      -> agent:3000 -> api:4000
                                             └─ everything else         -> SPA (fallback to the shell)
migrate (one-shot, before api) -> postgres     backup (daily pg_dump) -> postgres
```

Files: `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/smoke.sh`. Images: `ghcr.io/<owner>/dalva-api`, `dalva-web`, `dalva-agent`.

Only the agent reaches the internet. Postgres, API and backup sit on internal networks; `web` joins Dokploy's `dokploy-network` so Traefik can reach it. Every service runs read-only, with no capabilities, `no-new-privileges`, CPU and memory limits and rotated logs; the long-running ones have healthchecks. `postgres` runs as its own user, API, web and agent as 65532, `backup` as root without capabilities.

## Images

`.github/workflows/images.yml` builds each image when its inputs changed since the last successful run. After the first merge, run it once by hand (Actions → Images → Run workflow on `main`) so all three images exist. Pull requests build only. Pushes to `main` publish `:<short-sha>` and `:latest`. A manual run (Actions → Images → Run workflow) builds all three; from another branch it publishes only `:<short-sha>`.

- `dalva-api`: bundled server plus the migration runner and `apps/api/drizzle`. `bun main.js` serves; `bun src/db/migrate.js` migrates and exits.
- `dalva-web`: the SPA built with Bun, served by Caddy (`apps/web/Caddyfile`). No build-time settings: the bot username comes from the API's `TELEGRAM_BOT_USERNAME`.
- `dalva-agent`: unchanged name, tags and triggers.

`.github/workflows/stack.yml` runs on pull requests that touch `deploy/**`, a Dockerfile, the Caddyfile or migrations: it builds the three images, starts the stack on an empty database and runs `deploy/smoke.sh`.

## Secrets and settings

Everything lives in the stack's environment (Dokploy: Environment tab; by hand: `deploy/.env`, a copy of `deploy/.env.example`). Compose uses it for interpolation; each service gets only its own variables, so the agent never sees `BETTER_AUTH_SECRET` and the API never sees the bot token.

Generate secrets with `openssl rand -hex 32`. Hex matters: the Postgres password goes into a URL and the webhook secret takes only `A-Za-z0-9_-`. Every secret must differ from the others.

| Var | |
| --- | --- |
| `GHCR_OWNER` | GitHub owner, lowercase. |
| `POSTGRES_PASSWORD` | Generate. Only read when the volume is first created; changing it later needs `ALTER ROLE` too. |
| `PUBLIC_URL` | `https://<hostname>`, no path, the same as the Dokploy domain. Web, API and webhook share it. |
| `BETTER_AUTH_SECRET` | Generate. Signs session cookies and, derived from it, the agent's user tokens. Changing it signs everyone out. |
| `FINANCE_API_SERVICE_KEY` | Generate. The agent's service key; compose gives the same value to API and agent. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | From BotFather. The API serves the username to Settings → Telegram; the agent uses both. |
| `TELEGRAM_WEBHOOK_SECRET` | Generate. Also used by `telegram:webhook:set`. |
| `AI_PROVIDER`, `AGENT_MODEL`, `AI_GATEWAY_API_KEY` / `OPENROUTER_API_KEY` | Model provider: `gateway` (Vercel AI Gateway) or `openrouter`, and a model id. |

Optional: `API_IMAGE_TAG`, `WEB_IMAGE_TAG`, `AGENT_IMAGE_TAG` (`latest` by default, or a short SHA; each image is tagged with the commit that built it, so the three SHAs usually differ, see Updates) and `COMPOSE_PROJECT_NAME` (a second stack on the same host, e.g. `dalva-staging`).

Fixed in `docker-compose.yml`, not settings: database and role name (`dalva`), `NODE_ENV=production`, `CLIENT_IP_HEADER=cf-connecting-ip`, the Postgres image version, and the backup (daily 03:00 UTC, 14 days). The agent's tuning (session idle, rate limit, step and timeout limits, time zone) and the log levels keep their defaults in code. The API and the agent validate their env at boot and exit naming the bad variable, never the value. `FINANCE_API_URL` is fixed to `http://api:4000` by compose.

## First deploy

Steps for a staging stack next to production on the same VPS. Production uses the same steps with the production hostname and the production bot.

1. **Bot.** Create a second bot in BotFather for staging. A bot has one webhook: registering staging on the production bot takes it from production.
2. **Domain.** In Dokploy, create the compose service from this repo (`deploy/docker-compose.yml`) and add a domain: `staging.dalva.example.com`, service `web`, port `8080`, no path. Point it at Cloudflare as usual. Caddy decides what is reachable; the agent's and API's `/health` are not routed.
3. **WAF.** Telegram must reach `/webhooks/telegram` on that hostname: no Cloudflare Access on it, and skip Bot Fight / Super Bot Fight Mode for that path (details in [Let Telegram through](#let-telegram-through)).
4. **Images.** Make the three GHCR packages public, or `docker login ghcr.io` on the VPS with a PAT that has `read:packages`.
5. **Stack.** On the VPS:
   ```bash
   git clone <repo> dalva-staging && cd dalva-staging/deploy   # or copy deploy/ only
   cp .env.example .env        # COMPOSE_PROJECT_NAME=dalva-staging, PUBLIC_URL=https://staging.dalva.example.com, secrets
   docker compose pull
   docker compose up -d
   docker compose ps           # migrate: Exited (0); the rest healthy
   ```
   In Dokploy the stack is the compose service: set the environment, then Deploy. `dokploy-network` already exists there; on a plain host create it with `docker network create dokploy-network`.
6. **Smoke test.** `./smoke.sh` from `deploy/`: health, routing, sign-up and sign-in through Caddy, a backup and a restore into a scratch database (dropped after). It leaves one `smoke-*@example.com` user.
7. **Webhook.** From a dev machine, with the staging values in the shell (not in `apps/agent/.env`):
   ```bash
   set -a; . deploy/.env; set +a
   export AGENT_PUBLIC_URL="$PUBLIC_URL"
   cd apps/agent && bun run telegram:webhook:set && bun run telegram:webhook:info
   ```
8. **Check from outside.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://staging.dalva.example.com/                        # 200
   curl -s -o /dev/null -w '%{http_code}\n' https://staging.dalva.example.com/api/trpc/accounts.list   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://staging.dalva.example.com/webhooks/telegram  # 401
   ```
   Then sign up in the browser, finish onboarding, and link Telegram from Settings with the staging bot.

## Updates

```bash
cd deploy
docker compose pull
docker compose up -d
```

`migrate` runs on every `up` and the API waits for it, so a new API never starts on an old schema. Migrations are forward-only: rolling an image back does not roll the schema back. Before an update that carries a migration, take a backup (`docker compose run --rm backup now`).

Pin a release by setting each `*_IMAGE_TAG` to a short SHA from its package in GHCR (Packages → `dalva-api` / `dalva-web` / `dalva-agent` → tags). An image is only rebuilt when its inputs change, so each has its own SHA; for one SHA across all three, run Actions → Images → Run workflow on `main` (it builds all three; on `main` it also moves `:latest`). Roll back by setting the previous SHAs and running `up -d`, as long as no migration in between removed something the old code needs.

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
| Webhook `401` in `telegram:webhook:info` | `TELEGRAM_WEBHOOK_SECRET` differs from the one used for `set`. |
| Webhook `403`, nothing in agent logs | Cloudflare blocks Telegram. See [Let Telegram through](#let-telegram-through). |
| `unauthorized` or `denied` on pull | GHCR login missing or package private. |

## Let Telegram through

Telegram calls from datacenter IPs with no browser. Bot Fight Mode, Super Bot Fight Mode and a strict WAF can block it, and the failure is silent on your side.

- Don't put Cloudflare Access in front of this hostname.
- Super Bot Fight Mode (Pro and up): Security → WAF → Custom rules → hostname equals `dalva.example.com` and path equals `/webhooks/telegram` → action **Skip** → Super Bot Fight Mode rules (plus any managed rules that block it).
- Bot Fight Mode (Free) can't be skipped by a rule. If `info` shows 403s, turn it off for the zone or serve the app from a zone where it is off.
- Check Security → Events for blocks on that path.

### Optional: only Telegram's IPs

Custom rule, action **Block**: hostname equals `dalva.example.com` and path equals `/webhooks/telegram` and `ip.src` not in `{149.154.160.0/20 91.108.4.0/22}`. Confirm the ranges at <https://core.telegram.org/bots/webhooks> first. The secret header is the real auth; this only cuts noise.
