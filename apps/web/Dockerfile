# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/web/Dockerfile .
# Context filter: apps/web/Dockerfile.dockerignore (BuildKit picks it over the root .dockerignore).
#
# The SPA, served by Caddy, which is also the stack's single entry: it proxies
# /api/auth/* and /api/v1/* to the API and /webhooks/telegram to the agent.

ARG BUN_VERSION=1.4.0

# ---- build: static SPA (dist/client) ----
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /repo
# Every workspace manifest, so the lockfile resolves and --frozen-lockfile holds.
COPY package.json bun.lock ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/backend/package.json packages/backend/
COPY packages/finance-contract/package.json packages/finance-contract/
RUN bun install --frozen-lockfile --filter '@mpf/web' --ignore-scripts
COPY tsconfig.json ./
COPY packages packages
COPY apps/web apps/web
# Build-time: Vite inlines VITE_* into the bundle. Changing one means a new image.
ARG VITE_TELEGRAM_BOT_USERNAME=""
# Legacy: the web app reads VITE_CONVEX_URL until it moves to apps/api, and the shell prerender
# fails without one. A non-routable placeholder keeps the build working; the image never reaches Convex.
# Drop this arg once the web app no longer reads it.
ARG VITE_CONVEX_URL=""
WORKDIR /repo/apps/web
RUN VITE_CONVEX_URL="${VITE_CONVEX_URL:-https://convex.invalid}" \
    VITE_TELEGRAM_BOT_USERNAME="${VITE_TELEGRAM_BOT_USERNAME}" \
    bun --bun run build

# ---- runtime: Caddy, non-root, read-only friendly ----
FROM caddy:2.11.9-alpine AS runtime
# No admin API, no autosave, no certificates: Caddy needs nothing writable but /tmp.
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist/client /srv
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
