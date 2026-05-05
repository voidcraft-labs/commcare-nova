# --- Stage 1: Install dependencies ---
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- Stage 2: Atlas binary source ---
#
# `arigaio/atlas:latest` is the upstream-maintained Atlas image.
# The image is distroless with `ENTRYPOINT ["/atlas"]`, so
# `COPY --from=atlas-binary /atlas ...` lifts a single statically-
# linked Go binary into the runner stage. Pinning to `latest`
# rather than a specific tag tracks the upstream's stable release;
# Atlas's CLI surface is backwards-compatible across minor versions
# and the migration directory's `atlas.sum` integrity hash catches
# any directory-format drift across versions before apply runs.
FROM arigaio/atlas:latest AS atlas-binary

# --- Stage 3: Build the application ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects anonymous telemetry — disable in CI/build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# --- Stage 4: Production runner ---
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Don't run as root in production.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output + static/public assets.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Atlas binary + migration assets. The atlas binary lives on PATH
# so the CMD invocation reads as a normal command. The migrations
# directory + atlas.hcl land at the working directory's repo-
# relative paths (atlas reads `file://lib/case-store/migrations`
# per `atlas.hcl`'s prod env). The schema.sql source is also
# carried so a developer reaching into the running container sees
# the same file layout they'd see locally.
COPY --from=atlas-binary /atlas /usr/local/bin/atlas
COPY --chown=nextjs:nodejs atlas.hcl ./atlas.hcl
COPY --chown=nextjs:nodejs lib/case-store/schema.sql ./lib/case-store/schema.sql
COPY --chown=nextjs:nodejs lib/case-store/migrations ./lib/case-store/migrations

USER nextjs

# Cloud Run injects PORT (defaults to 8080).
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"
EXPOSE 8080

# Atlas applies any pending migrations, then the Next.js server
# starts. The `&&` chain means a migration failure aborts before
# `node server.js` runs — the Cloud Run instance never serves
# traffic on a failed migration, so a bad migration triggers
# Cloud Run's startup-probe failure mode and the deploy rolls back
# without sending requests at the broken schema.
#
# `--allow-dirty` suppresses Atlas's empty-database precondition
# check. Production has the postgis-managed `tiger` and `topology`
# schemas pre-installed (Task 0 runbook §Phase 5); Atlas would
# otherwise refuse to apply against the non-empty database. The
# flag only relaxes the precondition; Atlas's
# `atlas_schema_revisions` ledger remains the authoritative version
# source after the first apply, so the flag is safe to pass on
# every restart and does not imply re-applying already-applied
# migrations.
#
# Concurrency: Atlas holds Postgres advisory lock
# `atlas_migrate_execute` for the duration of the apply, so
# concurrent Cloud Run instance startups serialize cleanly. Only
# the first instance applies; the rest wait for the lock then
# no-op (no pending migrations) and proceed to `exec node
# server.js`.
#
# `exec` replaces the shell with the Node process so SIGTERM /
# SIGKILL from Cloud Run reaches Node directly — without `exec`,
# the shell would intercept the signal and Node would never get a
# graceful-shutdown opportunity.
CMD ["sh", "-c", "atlas migrate apply --env prod --allow-dirty && exec node server.js"]
