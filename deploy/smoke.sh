#!/bin/sh
# Smoke test for a running stack (CI, or staging after a deploy): health, routing through
# the web entry, sign-up and sign-in, then a backup restored into a scratch database.
#   deploy/smoke.sh            uses deploy/docker-compose.yml and deploy/.env
# Leaves one smoke-*@example.com user behind. Never touches the live database otherwise.
set -eu
cd "$(dirname "$0")"

CURL_IMAGE=curlimages/curl:8.22.0
WAIT_SECONDS=${WAIT_SECONDS:-180}

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
container() { id=$(docker compose ps -q "$1"); [ -n "$id" ] || fail "$1 is not running"; echo "$id"; }

# ---- health ----
wait_healthy() {
  for service in "$@"; do
    id=$(container "$service")
    elapsed=0
    while :; do
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
      [ "$status" = healthy ] && break
      [ "$elapsed" -ge "$WAIT_SECONDS" ] && { docker compose logs --tail 50 "$service" >&2; fail "$service is $status after ${WAIT_SECONDS}s"; }
      sleep 3
      elapsed=$((elapsed + 3))
    done
    ok "$service healthy"
  done
}
wait_healthy postgres api web agent backup

migrate=$(docker compose ps -a -q migrate)
[ -n "$migrate" ] || fail "migrate never ran"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$migrate")" = 0 ] || fail "migrate exited non-zero"
ok "migrate exited 0"

for target in api:4000 agent:3000; do
  service=${target%%:*}
  docker compose exec -T "$service" bun -e "const r=await fetch('http://127.0.0.1:${target#*:}/health');console.log(await r.text());process.exit(r.ok?0:1)" \
    || fail "$service /health"
  ok "$service /health"
done

# ---- routing through the web entry (what cloudflared sees) ----
web=$(container web)
api=$(container api)
public_url=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api" | sed -n 's/^PUBLIC_URL=//p')
[ -n "$public_url" ] || fail "PUBLIC_URL not set on api"
client_ip_header=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api" | sed -n 's/^CLIENT_IP_HEADER=//p')
web_curl() { docker run --rm --network "container:$web" "$CURL_IMAGE" -sS "$@"; }
status() { web_curl -o /dev/null -w '%{http_code}' "$@"; }
expect() { got=$1; want=$2; what=$3; [ "$got" = "$want" ] || fail "$what: got $got, want $want"; ok "$what -> $got"; }

expect "$(status http://127.0.0.1:8080/)" 200 "GET / (SPA shell)"
expect "$(status http://127.0.0.1:8080/transactions)" 200 "GET /transactions (SPA fallback)"
web_curl http://127.0.0.1:8080/does-not-exist | grep -q '<html' || fail "SPA fallback is not HTML"
expect "$(status http://127.0.0.1:8080/api/unknown)" 404 "GET /api/unknown"
expect "$(status http://127.0.0.1:8080/api/v1/accounts)" 404 "GET /api/v1/accounts (removed)"
expect "$(status http://127.0.0.1:8080/api/trpc/accounts.list)" 401 "GET /api/trpc/accounts.list without session"
# The agent answers 503 until boot recovery finishes, even while /health is already 200.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  webhook=$(status -X POST http://127.0.0.1:8080/webhooks/telegram)
  [ "$webhook" = 503 ] || break
  sleep 3
done
expect "$webhook" 401 "POST /webhooks/telegram without secret (agent)"

# ---- sign-up, sign-in, session through the web entry ----
email="smoke-$(date +%s)-$$@example.com"
password="Smoke-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
auth() {
  web_curl -D - -o /dev/null -w 'status:%{http_code}\n' -X POST "http://127.0.0.1:8080/api/auth/$1" \
    -H 'content-type: application/json' -H "origin: $public_url" \
    -H "${client_ip_header:-cf-connecting-ip}: 203.0.113.10" \
    --data "$2"
}
signup=$(auth sign-up/email "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"Smoke\"}")
echo "$signup" | grep -q '^status:200' || fail "sign-up: $(echo "$signup" | head -1)"
ok "sign-up"
signin=$(auth sign-in/email "{\"email\":\"$email\",\"password\":\"$password\"}")
echo "$signin" | grep -q '^status:200' || fail "sign-in: $(echo "$signin" | head -1)"
cookie=$(echo "$signin" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*dalva\.session_token=[^;]*\).*/\1/p' | head -1)
[ -n "$cookie" ] || fail "sign-in set no session cookie"
ok "sign-in"
web_curl -H "cookie: $cookie" http://127.0.0.1:8080/api/auth/get-session | grep -q "\"$email\"" || fail "get-session"
ok "get-session"
expect "$(status -H "cookie: $cookie" http://127.0.0.1:8080/api/trpc/accounts.list)" 200 "GET /api/trpc/accounts.list with session"

# ---- backup, then restore into a scratch database ----
out=$(docker compose run --rm -T backup now)
echo "$out"
file=$(echo "$out" | sed -n 's/.*"msg":"backup_done","file":"\([^"]*\)".*/\1/p' | tail -1)
[ -n "$file" ] || fail "backup wrote no file"
ok "backup $file"

scratch="restore_check_$(date +%s)"
docker compose run --rm -T backup restore "$file" "$scratch" || fail "restore"
psql() { docker compose exec -T postgres sh -c "psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"$1\" -tAc \"$2\""; }
live_db=$(docker compose exec -T postgres sh -c 'echo "$POSTGRES_DB"' | tr -d '\r')
count_tables="select count(*) from information_schema.tables where table_schema in ('public', 'drizzle')"
[ "$(psql "$scratch" "$count_tables")" = "$(psql "$live_db" "$count_tables")" ] || fail "restored table count differs"
[ "$(psql "$scratch" "select count(*) from users where email = '$email'")" = 1 ] || fail "restored database lacks the smoke user"
psql "$live_db" "drop database $scratch" > /dev/null
ok "restore into $scratch matches, dropped"

echo "smoke test passed"
