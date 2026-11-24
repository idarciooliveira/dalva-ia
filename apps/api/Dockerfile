# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/api/Dockerfile .
# Context filter: apps/api/Dockerfile.dockerignore (BuildKit picks it over the root .dockerignore).

ARG BUN_VERSION=1.4.0

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /repo
# Every workspace manifest, so the lockfile resolves and --frozen-lockfile holds.
COPY package.json bun.lock ./
COPY apps/agent/package.json apps/agent/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --filter '@mpf/api' --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY packages/shared/src packages/shared/src
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
RUN bun build apps/api/src/main.ts --target bun --minify-syntax --minify-whitespace --outfile /out/main.js \
 && bun build apps/api/src/db/migrate-cli.ts --target bun --minify-syntax --minify-whitespace --outfile /out/src/db/migrate.js

FROM oven/bun:${BUN_VERSION}-distroless AS runtime
WORKDIR /app
COPY --from=build --chown=65532:65532 /out/ ./
COPY --chown=65532:65532 apps/api/drizzle ./drizzle
# Bun writes under $HOME at runtime; the root is read-only in compose, /tmp is a tmpfs.
ENV NODE_ENV=production \
    PORT=4000 \
    HOME=/tmp
USER 65532:65532
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||4000}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["bun"]
CMD ["main.js"]
