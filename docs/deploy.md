# Deploy

The whole app runs from one compose stack on the VPS: web (Caddy + SPA), API, agent, Postgres, nightly backup and cloudflared. No open ports. Production still runs the legacy setup (Convex + Vercel + the agent stack in `deploy/agent/`) until cutover: see [Legacy: agent on Convex](#legacy-agent-on-convex).

```text
Cloudflare edge -> tunnel -> cloudflared -> web:8080 (Caddy, single entry)
                                             ├─ /api/auth/*, /api/v1/*  -> api:4000 -> postgres
                                             ├─ /webhooks/telegram      -> agent:3000 -> api:4000
                                             └─ everything else         -> SPA (fallback to the shell)
migrate (one-shot, before api) -> postgres     backup (daily pg_dump) -> postgres
```

Files: `deploy/docker-compose.yml`, `deploy/.env.example`, `deploy/smoke.sh`. Images: `ghcr.io/<owner>/dalva-api`, `dalva-web`, `dalva-agent`.

Only the agent and cloudflared reach the internet. Postgres, API, web and backup sit on internal networks. Every service runs read-only, with no capabilities, `no-new-privileges`, CPU and memory limits and rotated logs; the long-running ones have healthchecks. `postgres` runs as its own user, API, web and agent as 65532, `backup` as root without capabilities.

## Images

`.github/workflows/images.yml` builds each image when its inputs changed since the last successful run. After the first merge, run it once by hand (Actions → Images → Run workflow on `main`) so all three images exist. Pull requests build only. Pushes to `main` publish `:<short-sha>` and `:latest`. A manual run (Actions → Images → Run workflow) builds all three; from another branch it publishes only `:<short-sha>`.

- `dalva-api`: bundled server plus the migration runner and `apps/api/drizzle`. `bun main.js` serves; `bun src/db/migrate.js` migrates and exits.
- `dalva-web`: the SPA built with Bun, served by Caddy (`apps/web/Caddyfile`). `VITE_TELEGRAM_BOT_USERNAME` is build-time: set the repo variable `TELEGRAM_BOT_USERNAME` (Settings → Secrets and variables → Actions → Variables) and re-run the workflow after changing it.
- `dalva-agent`: unchanged name, tags and triggers.

`.github/workflows/stack.yml` runs on pull requests that touch `deploy/**`, a Dockerfile, the Caddyfile or migrations: it builds the three images, starts the stack on an empty database without cloudflared and runs `deploy/smoke.sh`.

## Secrets and settings

Everything lives in `deploy/.env` (copy of `deploy/.env.example`). Compose uses it for interpolation; each service gets only its own variables, so the agent never sees `BETTER_AUTH_SECRET` and the API never sees the bot token.

Generate secrets with `openssl rand -hex 32`. Hex matters: the Postgres password goes into a URL and the webhook secret takes only `A-Za-z0-9_-`. Every secret must differ from the others.

| Var | |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `dalva` for production, `dalva-staging` for staging on the same host. Prefixes containers, volumes, networks. |
| `GHCR_OWNER` | GitHub owner, lowercase. |
| `API_IMAGE_TAG`, `WEB_IMAGE_TAG`, `AGENT_IMAGE_TAG` | `latest` or a short SHA. Each image is tagged with the commit that built it, so the three SHAs usually differ (see Updates). |
| `POSTGRES_USER`, `POSTGRES_DB` | `dalva`. |
| `POSTGRES_PASSWORD` | Generate. Only read when the volume is first created; changing it later needs `ALTER ROLE` too. |
| `NODE_ENV` | `production`. |
| `PUBLIC_URL` | `https://<hostname>`, no path. Web, API and webhook share it. |
| `BETTER_AUTH_SECRET` | Generate. Signs session cookies; changing it signs everyone out. |
| `FINANCE_API_TOKEN_SECRET` | Generate. Signs the agent's user tokens. |
| `FINANCE_API_SERVICE_KEY` | Generate. The agent's service key; compose gives the same value to API and agent. |
| `CLIENT_IP_HEADER` | `cf-connecting-ip`. Auth rate limits key on it. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | From BotFather. |
| `TELEGRAM_WEBHOOK_SECRET` | Generate. Also used by `telegram:webhook:set`. |
| `AI_PROVIDER`, `AGENT_MODEL`, `AI_GATEWAY_API_KEY` / `OPENROUTER_API_KEY` | Model provider, as in the legacy agent. |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token. |
| `BACKUP_AT`, `BACKUP_KEEP_DAYS` | Daily dump time (UTC, `HH:MM`) and retention. Defaults `03:00`, `14`. |

The optional agent and API tuning variables are listed in `.env.example`. The API and the agent validate their env at boot and exit naming the bad variable, never the value. `FINANCE_API_URL` is fixed to `http://api:4000` by compose.

## First deploy (staging)

Prove the stack on a staging hostname with an empty database before cutover. Staging runs next to the legacy agent on the same VPS without touching it.

1. **Bot.** Create a second bot in BotFather for staging. A bot has one webhook: registering staging on the production bot takes it from production.
2. **Tunnel.** Zero Trust → Networks → Tunnels → create a tunnel for staging and copy its token. Add one public hostname: `staging.dalva.example.com`, no path, service `HTTP` → `web:8080`. Caddy decides what is reachable; the agent's and API's `/health` are not routed.
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
   With a panel, paste `docker-compose.yml` as a stack and give it the `.env` values (Portainer: stack env). It needs no other file.
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
   curl -s -o /dev/null -w '%{http_code}\n' https://staging.dalva.example.com/api/v1/accounts         # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://staging.dalva.example.com/webhooks/telegram  # 401
   ```
   Then sign up in the browser, finish onboarding, and link Telegram from Settings with the staging bot. Pages still on Convex (transactions, goals, debts, dashboard widgets, Telegram linking) show an error in this image until the web migration finishes; auth, onboarding, accounts and categories already run on the API.

Production at cutover follows the same steps with `COMPOSE_PROJECT_NAME=dalva`, the production hostname and the production bot, after the data migration.

## Updates

```bash
cd deploy
docker compose pull
docker compose up -d
```

`migrate` runs on every `up` and the API waits for it, so a new API never starts on an old schema. Migrations are forward-only: rolling an image back does not roll the schema back. Before an update that carries a migration, take a backup (`docker compose run --rm backup now`).

Pin a release by setting each `*_IMAGE_TAG` to a short SHA from its package in GHCR (Packages → `dalva-api` / `dalva-web` / `dalva-agent` → tags). An image is only rebuilt when its inputs change, so each has its own SHA; for one SHA across all three, run Actions → Images → Run workflow on `main` (it builds all three; on `main` it also moves `:latest`). Roll back by setting the previous SHAs and running `up -d`, as long as no migration in between removed something the old code needs.

## Backup and restore

The `backup` service dumps the database daily at `BACKUP_AT` (UTC) into the `backups` volume as `<db>-YYYYmmdd-HHMMSS.dump` (`pg_dump --format=custom`) and deletes dumps more than `BACKUP_KEEP_DAYS` full days old (`find -mtime +N`: 14 keeps 15 dailies). The volume is on the same host: copy dumps off it regularly.

```bash
docker compose run --rm backup now                       # dump now
docker compose run --rm backup list                      # what is on disk
docker run --rm -v dalva_backups:/b -v "$PWD":/out alpine cp /b/<file> /out/   # copy one off the volume (<project>_backups)
```

Restore always goes into a new database; it refuses one that exists. Volume names carry the project prefix: `dalva_backups` in production, `dalva-staging_backups` on staging.

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
| Cloudflare `502`/`530` | cloudflared can't reach `web:8080`, or `web` is unhealthy. `docker compose ps`. |
| Sign-in works but the app shows signed out | `PUBLIC_URL` differs from the hostname in the browser: the cookie is `Secure` and bound to that origin. |
| Webhook `401` in `telegram:webhook:info` | `TELEGRAM_WEBHOOK_SECRET` differs from the one used for `set`. |
| Webhook `403`, nothing in agent logs | Cloudflare blocks Telegram. See [Let Telegram through](#let-telegram-through). |
| `unauthorized` or `denied` on pull | GHCR login missing or package private. |

## Legacy: agent on Convex

Production until cutover: the agent stack in `deploy/agent/` (image `dalva-agent`, unchanged), backend on Convex cloud, web on Vercel. Removed after the rollback window.

```text
Telegram -> Cloudflare edge -> tunnel -> cloudflared -> http://dalva-agent:3000/webhooks/telegram
                                                       (everything else: 404)
```

Prerequisites: a bot from BotFather (token and username), a hostname for the agent (e.g. `agent.example.com`), the image published by the `Images` workflow.

### Env vars

Generate each secret with `openssl rand -base64 48`. Exception: `TELEGRAM_WEBHOOK_SECRET` takes only `A-Za-z0-9_-`, so use `openssl rand -hex 32`.

#### Convex (from `packages/backend`: `bunx convex env set NAME value`, add `--prod` for production)

| Var | |
| --- | --- |
| `FINANCE_API_TOKEN_SECRET` | Signs user tokens. Generate. At least 32 bytes. |
| `FINANCE_API_SERVICE_KEY` | The agent's service key. Generate. At least 32 bytes, different from the token secret. |

The service key must be identical in Convex and in the agent.

#### Vercel (Project → Settings → Environment Variables, Production)

| Var | |
| --- | --- |
| `VITE_TELEGRAM_BOT_USERNAME` | Bot username, no `@`. Build-time: redeploy after changing it. Without it Settings shows only the `/start` fallback. |

#### Agent (stack env, see `deploy/agent/.env.example`)

| Var | Value |
| --- | --- |
| `GHCR_OWNER` | GitHub owner of the repo, lowercase. Compose only. |
| `AGENT_IMAGE_TAG` | `latest` or a short SHA. Compose only. |
| `TELEGRAM_BOT_TOKEN` | From BotFather. |
| `TELEGRAM_BOT_USERNAME` | Bot username, no `@`. |
| `TELEGRAM_MODE` | `webhook`. Never `polling` here: it deletes the webhook at boot. |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32`. Also sent as `secret_token` by `setWebhook`. |
| `FINANCE_API_URL` | Convex site URL, `https://<deployment>.convex.site` (not `.convex.cloud`). |
| `FINANCE_API_SERVICE_KEY` | Same as in Convex. |
| `PORT` | Forced to `3000` by compose. |
| `LOG_LEVEL` | `info` default. |
| `SESSION_IDLE_MINUTES` | `30` default. |
| `RECOVERY_MAX_AGE_SECONDS` | `120` default. |
| `AI_PROVIDER` | `gateway` (Vercel AI Gateway) or `openrouter`. |
| `AGENT_MODEL` | Model id for that provider, e.g. `anthropic/claude-sonnet-5-5`. Required, no default. |
| `AI_GATEWAY_API_KEY` | Gateway key (Vercel → AI Gateway → API keys). Needed when `AI_PROVIDER=gateway`. |
| `OPENROUTER_API_KEY` | OpenRouter key. Needed when `AI_PROVIDER=openrouter`. |
| `AGENT_MAX_STEPS` | Model calls per turn, `6` default (1-10). |
| `AGENT_MAX_OUTPUT_TOKENS` | Cap per model call, `1024` default (64-8192). |
| `AGENT_TURN_TIMEOUT_SECONDS` | `45` default. |
| `AGENT_RATE_LIMIT_TURNS` / `AGENT_RATE_LIMIT_WINDOW_MINUTES` | `20` turns per `10` minutes per user, default. |
| `DEFAULT_TIMEZONE` | `Africa/Luanda` default. |

Switching provider or model is an env change and a restart; stored chat history stays usable. Set a spend limit on the provider account: the agent caps steps, output tokens and turns per user, but has no global budget. On stop, agent turns still running after 5s are aborted (the user gets the generic apology) so the drain finishes and recovery never pays for a turn twice.

The agent validates all of this at boot and exits naming the bad variables, never the values.

Compose reads `.env` next to the compose file. Panels that inject variables another way (Portainer: `stack.env`) need `env_file` to point at that file.

### Cloudflare Tunnel

Zero Trust → Networks → Tunnels → your tunnel. The `cloudflared` container must be on the `dalva-agent` network (`docker network connect dalva-agent cloudflared`, or `networks: { dalva-agent: { external: true } }` in its stack). Caveats:

- The network is created by this stack: deploy it before a stack that declares it `external`.
- `docker network connect` is lost when the cloudflared container is recreated; prefer the compose form.
- cloudflared with `network_mode: host` can't resolve `dalva-agent`. Use the container IP, or put it on the network.

No cloudflared yet: put `TUNNEL_TOKEN=<token>` in `tunnel.env` next to the compose file (gitignored; keep it out of `.env`, which the agent loads) and uncomment the service.

### Only the webhook is public

Add one public hostname (shown as "Published application routes" in newer dashboards):

| Field | Value |
| --- | --- |
| Hostname | `agent.example.com` |
| Path | `^/webhooks/telegram$` |
| Service | `HTTP` → `dalva-agent:3000` |

The path is a regex: keep the anchors, or `/webhooks/telegram/anything` also matches. Leave the catch-all `HTTP Status 404` as the last rule. `/health` has no auth and stays unreachable from outside.

Check from any machine:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://agent.example.com/health                      # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agent.example.com/webhooks/telegram   # 401
```

401 means the request reached the agent and was refused for the missing secret. 503 means it is still booting (recovery): retry in a few seconds. Anything else: see Common failures.

### Let Telegram through

Telegram calls from datacenter IPs with no browser. Bot Fight Mode, Super Bot Fight Mode and a strict WAF can block it, and the failure is silent on your side.

- Don't put Cloudflare Access in front of this hostname.
- Super Bot Fight Mode (Pro and up): Security → WAF → Custom rules → hostname equals `agent.example.com` and path equals `/webhooks/telegram` → action **Skip** → Super Bot Fight Mode rules (plus any managed rules that block it).
- Bot Fight Mode (Free) can't be skipped by a rule. If `info` shows 403s, turn it off for the zone or serve the agent from a zone where it is off.
- Check Security → Events for blocks on that path.

### Optional: only Telegram's IPs

Custom rule, action **Block**: hostname equals `agent.example.com` and path equals `/webhooks/telegram` and `ip.src` not in `{149.154.160.0/20 91.108.4.0/22}`. Confirm the ranges at <https://core.telegram.org/bots/webhooks> first. The secret header is the real auth; this only cuts noise.

### First deploy

1. **Image access.** GHCR packages are private by default. Either make `dalva-agent` public (Packages → package settings), or on the VPS run `docker login ghcr.io -u <github-user>` with a PAT that has `read:packages`.
2. **Stack.** Create a stack in the panel, paste `deploy/agent/docker-compose.yml`, fill the env from `.env.example`, deploy.
3. **Health, inside the network.** The container should turn `healthy`. To check by hand:
   ```bash
   docker run --rm --network dalva-agent curlimages/curl -s http://dalva-agent:3000/health
   # {"ok":true,...,"mode":"webhook","accepting":true,"financeApi":"ok",...}
   ```
   `accepting:false` means boot recovery is still running; `financeApi` not `ok` means the backend is unreachable.
4. **Tunnel route and WAF**: as above, then run the two `curl` checks.
5. **Register the webhook.** From a dev machine, load the production values into the shell, not into `apps/agent/.env`: that file is for the dev bot, and `bun run dev:agent` with the production token deletes the production webhook.
   ```bash
   set -a; . deploy/agent/.env; set +a      # TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, AGENT_PUBLIC_URL=https://agent.example.com
   cd apps/agent
   bun run telegram:webhook:set             # DROP_PENDING_UPDATES=1 to discard anything queued
   bun run telegram:webhook:info            # url set; last error none (or an old timestamp)
   ```
   `set` sends `allowed_updates: ["message","callback_query"]` and the secret as `secret_token`. `info` never prints the token or secret. Telegram keeps the last error after it is fixed: trust the timestamp, not the presence of the line.
6. **Smoke test.** Web app → Settings → Telegram → open the link, press Start. The bot confirms and Settings shows the chat as linked. `docker logs dalva-agent` should have no `webhook_unauthorized`.

### Updating

Pushes to `main` that touch `apps/agent/**` or `packages/finance-contract/**` publish `:<short-sha>` and `:latest`. In the panel: pull the image and redeploy the stack (`AGENT_IMAGE_TAG=latest`). The agent drains for up to 8s on stop; Telegram retries what it got a 503 for.

Pin a version by setting `AGENT_IMAGE_TAG` to a short SHA.

### Rollback

Set `AGENT_IMAGE_TAG` to the previous short SHA (GitHub → Packages → `dalva-agent` → tags) and redeploy. Don't use `latest` until the fix is on `main`.

### Logs

```bash
docker logs -f --tail 100 dalva-agent
docker logs dalva-agent 2>&1 | jq 'select(.level=="error" or .level=="warn")'
```

JSON lines with ids, kinds and error codes only. Rotation is 5 files of 10 MB.

### Common failures

| Symptom | Cause and fix |
| --- | --- |
| `info` shows `401`, logs show `webhook_unauthorized` | `TELEGRAM_WEBHOOK_SECRET` in the stack differs from the one used for `set`. Make them equal, redeploy if you changed the stack, re-run `set`. |
| Container restarts, logs end with `boot_failed` | Backend unreachable or key wrong. Check `FINANCE_API_URL` (`.convex.site`) and that `FINANCE_API_SERVICE_KEY` equals the Convex value. The restart policy retries until it's back. |
| Exit at boot with `Invalid environment: ...` | A variable is missing or malformed. The message names it. |
| `info` shows `404` | The path rule is wrong. Expect `^/webhooks/telegram$` and the same hostname you passed in `AGENT_PUBLIC_URL`. |
| `info` shows `502` or Cloudflare `530` | `cloudflared` can't reach `dalva-agent:3000`: not on the `dalva-agent` network, or the container is down. |
| `info` shows `403`, nothing in agent logs | Cloudflare is blocking Telegram. See Let Telegram through. |
| `curl` to the webhook returns `503` | Agent is in boot recovery or shutting down. Wait; if it persists, check `/health` and the backend. |
| `pending_update_count` keeps growing | The agent answers 503: still recovering, or the backend is down. Check `/health`. |
| Bot silent after `TELEGRAM_MODE=polling` | Polling deletes the webhook at boot. Set `webhook`, redeploy, re-run `set`. |
| `unauthorized` or `denied` on image pull | GHCR login missing or package private. See First deploy, step 1. |
