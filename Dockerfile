# Base image pinned to an exact Node patch, shared by every stage so they
# can't drift. The floating `node:22-alpine` tag silently advanced
# 22.22.3 → 22.23.0 between two source rebuilds with no code change, and
# 22.23.0 (a security release) carried an http keep-alive change that
# regressed the bundled undici: gaxios / google-auth-library token fetches
# to oauth2.googleapis.com and the metadata server began throwing
# ERR_STREAM_PREMATURE_CLOSE. Every `/api/auth/*` request touches Firestore
# (the rate limiter's per-request counter), so all of them 500'd — prod
# login went down with nothing in Sentry (the throw escapes Better Auth's
# own try/catch). See nodejs/node#63989. This is the same mutable-tag
# supply-chain logic that digest-pins arigaio/atlas below; an exact patch
# tag suffices here — it freezes Node while still flowing Alpine security
# patches. Bump deliberately once a corrected Node 22.x ships the undici fix.
#
# `.nvmrc` is the canonical Node version (CI reads it via `node-version-file`,
# local nvm/fnm read it directly). Keep this patch in lockstep with it — the
# `quality` CI job fails if `.nvmrc` and this ARG drift.
ARG NODE_IMAGE=node:22.22.3-alpine

# --- Stage 1: Install dependencies ---
FROM ${NODE_IMAGE} AS deps
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
FROM ${NODE_IMAGE} AS builder
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

# Google Maps config for the geopoint picker. `NEXT_PUBLIC_` vars are inlined
# into the client bundle by `next build`, so they MUST be present here at build
# time (a Cloud Run runtime env var would never reach them). Cloud Build passes
# the key from Secret Manager (`nova-google_maps_api_key`, the prod browser key)
# and the Map ID as a literal. A local `docker build` leaves them empty, and the
# picker degrades to manual lat/lon entry. The key is a referrer-restricted
# public key (it ships in the bundle by design), so this is not a secret leak.
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID

RUN npm run build

# --- Stage 4: Production runner ---
FROM ${NODE_IMAGE} AS runner
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
