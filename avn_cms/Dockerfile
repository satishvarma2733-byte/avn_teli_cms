# aVn CMS production image: one image for the web app, the worker and the migration step
# (the command decides which). See docs/DEPLOYMENT.md §4a and deploy/docker-compose.prod.yml.
#
#   docker build -t avn-cms .
#   docker run --env-file … -p 3300:3300 avn-cms                              # web
#   docker run --env-file … avn-cms pnpm --filter @avn-cms/worker start       # worker
#   docker run --env-file … avn-cms pnpm db:migrate                           # migrations
#
# Debian (glibc) rather than Alpine: Prisma's schema engine and the native Argon2 build are tested there.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true
RUN corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Dependencies: cached until a package.json or the lockfile changes ───────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

# ── Build ───────────────────────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# `prisma generate` insists that the owner URL exists; it never connects. No other value is needed
# to build: every page renders per request, so nothing reads the database or a secret at build time.
RUN DATABASE_OWNER_URL=postgresql://build:build@localhost:5432/build pnpm build

# ── Runtime ─────────────────────────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3300
# Liveness: the health route answers 200 (database and Redis up) or 503 (degraded).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3300/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
