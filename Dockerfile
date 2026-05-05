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
COPY --chown=nextjs:nodejs atlas.hcl ./atlas.hcl
COPY --chown=nextjs:nodejs lib/case-store/migrations ./lib/case-store/migrations

USER nextjs

# Cloud Run injects PORT (defaults to 8080).
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"
EXPOSE 8080

# Atlas applies any pending migrations, then the Next.js server
# starts. `&&` aborts the boot if migration fails, so the Cloud
# Run instance never serves traffic against a half-migrated
# schema. The `--allow-dirty` rationale, the advisory-lock
# concurrency model, and the IAM-auth URL composition all live
# in `lib/case-store/CLAUDE.md` § Production: Cloud Run startup
# CMD.
#
# `exec` replaces the shell with the Node process so SIGTERM
# from Cloud Run reaches Node directly — without `exec`, the
# shell would intercept the signal and Node would never get a
# graceful-shutdown opportunity.
CMD ["sh", "-c", "atlas migrate apply --env prod --allow-dirty && exec node server.js"]
