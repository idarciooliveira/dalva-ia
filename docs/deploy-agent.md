# Deploy the Telegram agent

Agent on your own VPS (Docker, managed from a panel), public through Cloudflare Tunnel. Backend is Convex cloud, web is Vercel. No open ports, no reverse proxy.

```text
Telegram -> Cloudflare edge -> tunnel -> cloudflared -> http://dalva-agent:3000/webhooks/telegram
                                                       (everything else: 404)
```

Files: `deploy/agent/docker-compose.yml`, `deploy/agent/.env.example`, image `ghcr.io/<owner>/dalva-agent`.

## Prerequisites

- A bot from [@BotFather](https://t.me/BotFather): keep the **token** and the **username** (no `@`).
- A hostname on a Cloudflare zone for the agent, e.g. `agent.example.com`.
- A VPS with Docker and a panel that deploys stacks from a compose file.
- The image published: merging to `main` runs the `Agent image` workflow, or run it by hand (Actions → Agent image → Run workflow).

## Env vars

Generate each secret with `openssl rand -base64 48`. Exception: `TELEGRAM_WEBHOOK_SECRET` takes only `A-Za-z0-9_-`, so use `openssl rand -hex 32`.

### Convex (`bunx convex env set NAME value`, add `--prod` for production)

| Var | |
| --- | --- |
| `FINANCE_API_TOKEN_SECRET` | Signs user tokens. Generate. At least 32 bytes. |
| `FINANCE_API_SERVICE_KEY` | The agent's service key. Generate. At least 32 bytes, different from the token secret. |

The service key must be identical in Convex and in the agent.

### Vercel (Project → Settings → Environment Variables, Production)

| Var | |
| --- | --- |
| `VITE_TELEGRAM_BOT_USERNAME` | Bot username, no `@`. Build-time: redeploy after changing it. Without it Settings shows only the `/start` fallback. |

### Agent (stack env, see `deploy/agent/.env.example`)

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

The agent validates all of this at boot and exits naming the bad variables, never the values.

Compose reads `.env` next to the compose file. Panels that inject variables another way (Portainer: `stack.env`) need `env_file` to point at that file.

## Cloudflare Tunnel

Zero Trust → Networks → Tunnels → your tunnel. The `cloudflared` container must be on the `dalva-agent` network (`docker network connect dalva-agent cloudflared`, or `networks: { dalva-agent: { external: true } }` in its stack). No cloudflared yet: uncomment the service in the compose file and set `CLOUDFLARE_TUNNEL_TOKEN`.

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

401 means the request reached the agent and was refused for the missing secret. Anything else on the second call: see Common failures.

### Let Telegram through

Telegram calls from datacenter IPs with no browser. Bot Fight Mode, Super Bot Fight Mode and a strict WAF can block it, and the failure is silent on your side.

- Don't put Cloudflare Access in front of this hostname.
- Super Bot Fight Mode (Pro and up): Security → WAF → Custom rules → hostname equals `agent.example.com` and path equals `/webhooks/telegram` → action **Skip** → Super Bot Fight Mode rules (plus any managed rules that block it).
- Bot Fight Mode (Free) can't be skipped by a rule. If `info` shows 403s, turn it off for the zone or serve the agent from a zone where it is off.
- Check Security → Events for blocks on that path.

### Optional: only Telegram's IPs

Custom rule, action **Block**: hostname equals `agent.example.com` and path equals `/webhooks/telegram` and `ip.src` not in `149.154.160.0/20 91.108.4.0/22`. Confirm the ranges at <https://core.telegram.org/bots/webhooks> first. The secret header is the real auth; this only cuts noise.

## First deploy

1. **Image access.** GHCR packages are private by default. Either make `dalva-agent` public (Packages → package settings), or on the VPS run `docker login ghcr.io -u <github-user>` with a PAT that has `read:packages`.
2. **Stack.** Create a stack in the panel, paste `deploy/agent/docker-compose.yml`, fill the env from `.env.example`, deploy.
3. **Health, inside the network.** The container should turn `healthy`. To check by hand:
   ```bash
   docker run --rm --network dalva-agent curlimages/curl -s http://dalva-agent:3000/health
   # {"ok":true,...,"mode":"webhook","accepting":true,"financeApi":"ok",...}
   ```
   `accepting:false` means boot recovery is still running; `financeApi` not `ok` means the backend is unreachable.
4. **Tunnel route and WAF**: as above, then run the two `curl` checks.
5. **Register the webhook.** From a dev machine, in `apps/agent/.env` set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (same value as the stack) and `AGENT_PUBLIC_URL=https://agent.example.com`:
   ```bash
   cd apps/agent
   bun run telegram:webhook:set    # DROP_PENDING_UPDATES=1 to discard anything queued
   bun run telegram:webhook:info   # url set, no last error
   ```
   `set` sends `allowed_updates: ["message","callback_query"]` and the secret as `secret_token`. `info` never prints the token or secret.
6. **Smoke test.** Web app → Settings → Telegram → open the link, press Start. The bot confirms and Settings shows the chat as linked. `docker logs dalva-agent` should have no `webhook_unauthorized`.

## Updating

Pushes to `main` that touch `apps/agent/**` or `packages/finance-contract/**` publish `:<short-sha>` and `:latest`. In the panel: pull the image and redeploy the stack (`AGENT_IMAGE_TAG=latest`). The agent drains for up to 8s on stop; Telegram retries what it got a 503 for.

Pin a version by setting `AGENT_IMAGE_TAG` to a short SHA.

## Rollback

Set `AGENT_IMAGE_TAG` to the previous short SHA (GitHub → Packages → `dalva-agent` → tags) and redeploy. Don't use `latest` until the fix is on `main`.

## Logs

```bash
docker logs -f --tail 100 dalva-agent
docker logs dalva-agent 2>&1 | jq 'select(.level=="error" or .level=="warn")'
```

JSON lines with ids, kinds and error codes only. Rotation is 5 files of 10 MB.

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `info` shows `401`, logs show `webhook_unauthorized` | `TELEGRAM_WEBHOOK_SECRET` in the stack differs from the one used for `set`. Make them equal, redeploy if you changed the stack, re-run `set`. |
| Container restarts, logs end with `boot_failed` | Backend unreachable or key wrong. Check `FINANCE_API_URL` (`.convex.site`) and that `FINANCE_API_SERVICE_KEY` equals the Convex value. The restart policy retries until it's back. |
| Exit at boot with `Invalid environment: ...` | A variable is missing or malformed. The message names it. |
| `info` shows `404` | The path rule is wrong. Expect `^/webhooks/telegram$` and the same hostname you passed in `AGENT_PUBLIC_URL`. |
| `info` shows `502` or Cloudflare `530` | `cloudflared` can't reach `dalva-agent:3000`: not on the `dalva-agent` network, or the container is down. |
| `info` shows `403`, nothing in agent logs | Cloudflare is blocking Telegram. See Let Telegram through. |
| `pending_update_count` keeps growing | The agent answers 503: still recovering, or the backend is down. Check `/health`. |
| Bot silent after `TELEGRAM_MODE=polling` | Polling deletes the webhook at boot. Set `webhook`, redeploy, re-run `set`. |
| `unauthorized` or `denied` on image pull | GHCR login missing or package private. See First deploy, step 1. |
