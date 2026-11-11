# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/agent/Dockerfile .

ARG BUN_VERSION=1.4.0

# ---- deps: install only what @mpf/agent needs, from the workspace lockfile ----
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /repo
# Every workspace manifest, so the lockfile resolves and --frozen-lockfile holds.
COPY package.json bun.lock ./
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY packages/backend/package.json packages/backend/
COPY packages/finance-contract/package.json packages/finance-contract/
RUN bun install --frozen-lockfile --filter '@mpf/agent' --ignore-scripts

# ---- build: bundle the service and @mpf/finance-contract into one file ----
FROM deps AS build
COPY tsconfig.json ./
COPY packages/finance-contract/src packages/finance-contract/src
COPY apps/agent/src apps/agent/src
RUN bun build apps/agent/src/main.ts --target bun --minify-syntax --minify-whitespace --outfile /out/main.js

# ---- runtime: no shell, no package manager, no source, non-root ----
FROM oven/bun:${BUN_VERSION}-distroless AS runtime
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/main.js ./main.js
ENV NODE_ENV=production \
    PORT=8080
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["bun", "main.js"]
