# --- Stage 1: Install dependencies ---
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- Stage 2: Atlas binary source ---
#
# `arigaio/atlas` is the upstream-maintained Atlas image. The image
# is distroless with `ENTRYPOINT ["/atlas"]`, so
# `COPY --from=atlas-binary /atlas ...` lifts a single statically-
# linked Go binary into the runner stage. We digest-pin the image:
# `:latest` is mutable, and atlas runs in our Cloud Run container
# with IAM credentials to Cloud SQL, so an upstream account
# compromise that pushed a malicious `:latest` would have a data-
# exfiltration blast radius. The same supply-chain logic governs
# the testcontainers harness's postgis image pin in
# `globalSetup.ts`.
#
# Bumping: pull `arigaio/atlas:latest`, capture the new digest with
# `docker inspect arigaio/atlas:latest --format='{{index .RepoDigests 0}}'`,
# and replace below. Bump on each Atlas minor release or quarterly,
# whichever comes first; the migration directory's `atlas.sum` file
# catches any directory-format drift the bump would otherwise hide.
FROM arigaio/atlas@sha256:6d34257110be51093e9daf215bf3bc17e6690214434b516196b1cc267dd1dac6 AS atlas-binary

# --- Stage 3: Build the application ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js collects anonymous telemetry — disable in CI/build.
ENV NEXT_TELEMETRY_DISABLED=1

# Cloud Build doesn't set CI itself; next.config.ts keys the Sentry
# plugin's verbosity on it (`silent: !process.env.CI`), so without this
# the deploy log can't show whether the source-map upload succeeded.
ENV CI=true

# Sentry uploads source maps during `next build` when this is set. Cloud Build
# passes it from Secret Manager (`nova-sentry`); a local `docker build` leaves
# it empty and the Sentry plugin skips the upload without failing the build.
# Only the builder stage sees it — nothing leaks into the pushed runner image.
ARG SENTRY_AUTH_TOKEN

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
# relative paths so atlas's `file://lib/case-store/migrations`
# URL resolves at startup. `schema.sql` is NOT copied — the prod
# env reads only `migration.dir`, not `schema.src`.
COPY --from=atlas-binary /atlas /usr/local/bin/atlas
# Force exec bit for the non-root `nextjs` user. The classic docker
# builder Cloud Build uses doesn't honor `COPY --chmod`, and the
# upstream arigaio/atlas image's binary perms don't reliably grant
# execute-for-other through the COPY. Without this, the runner exits
# 126 ("Permission denied") on startup before node ever binds :8080.
RUN chmod 0755 /usr/local/bin/atlas
COPY --chown=nextjs:nodejs atlas.hcl ./atlas.hcl
COPY --chown=nextjs:nodejs lib/case-store/migrations ./lib/case-store/migrations

USER nextjs

# Cloud Run injects PORT (defaults to 8080).
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"
EXPOSE 8080

# Boot is node-only — migrations do NOT run here. A per-boot
# `atlas migrate apply` put a Cloud SQL connect + advisory-lock
# acquisition on the cold-start critical path (Node didn't start
# until atlas finished), adding seconds to every cold start and
# serializing concurrent instance startups on the one lock. The
# migration now runs once per deploy via the `commcare-nova-migrate`
# Cloud Run Job (cloudbuild runs it before shifting traffic), so a
# cold boot is just Node coming up.
#
# The atlas binary + migrations stay copied into this image on
# purpose: the migrate Job reuses THIS image with a command
# override, so the binary and migration files must be present.
#
# Exec-form CMD (no `sh -c` wrapper) makes Node PID 1, so SIGTERM
# from Cloud Run reaches it directly for graceful shutdown.
CMD ["node", "server.js"]
