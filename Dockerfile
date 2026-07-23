# Base image pinned to an exact Node patch, shared by every stage so they
# can't drift. The floating `node:22-alpine` tag previously advanced
# 22.22.3 → 22.23.0 between two source rebuilds with no code change, and
# 22.23.0 (a security release) carried an http keep-alive change that
# regressed the bundled undici: gaxios / google-auth-library token fetches
# to oauth2.googleapis.com and the metadata server began throwing
# ERR_STREAM_PREMATURE_CLOSE. Every `/api/auth/*` request authenticates
# outbound over that same stack (the auth datastore + rate limiter), so all 500'd — prod
# login went down with nothing in Sentry (the throw escapes Better Auth's
# own try/catch). See nodejs/node#63989. This is the same mutable-tag
# supply-chain logic that digest-pins the testcontainers postgis image in
# `lib/case-store/sql/__tests__/globalSetup.ts`; an exact patch tag suffices
# here — it freezes Node while still flowing Alpine security patches. Node
# 24.18.0 is the LTS runtime and is new enough for independently pinned npm 12.
#
# `.nvmrc` is the canonical Node version (CI reads it via `node-version-file`,
# local nvm/fnm read it directly). Keep this patch in lockstep with it — the
# `quality` CI job fails if `.nvmrc` and this ARG drift.
ARG NODE_IMAGE=node:24.18.0-alpine
ARG NPM_VERSION=12.0.1

# Node 24 still bundles npm 11. Install the reviewed npm major independently
# for build-time dependency policy; the production runner invokes only `node`.
FROM ${NODE_IMAGE} AS build-base
ARG NPM_VERSION
RUN npm install --global "npm@${NPM_VERSION}" --ignore-scripts && \
	test "$(npm --version)" = "${NPM_VERSION}"

# --- Stage 1: Install dependencies ---
FROM build-base AS deps
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

# --- Stage 2: Build the application ---
FROM build-base AS builder
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

# Server Action / asset version-skew protection. Both are consumed by
# `next build`, not at runtime — a build ARG is visible to the RUN step's
# `process.env`, exactly like SENTRY_AUTH_TOKEN above, so neither needs a
# separate ENV line and neither leaks into the runner stage.
#   • NEXT_SERVER_ACTIONS_ENCRYPTION_KEY pins the key Next derives Server Action
#     IDs (and closure encryption) from. With it fixed, every UNCHANGED action
#     keeps the same ID across builds, so an already-open builder tab keeps
#     calling the new deploy's actions instead of getting "Failed to find Server
#     Action". Cloud Build passes it from Secret Manager (`nova-server-actions-key`);
#     a local `docker build` leaves it empty and Next falls back to a per-build
#     random key (fine for dev — there are no rolling deploys locally). It is a
#     server-side key (never shipped to the browser).
#   • NEXT_DEPLOYMENT_ID (a per-build id; cloudbuild passes $BUILD_ID) feeds
#     next.config.ts's `deploymentId`: on a deploy that DID change/remove an
#     action, or when a stale JS chunk is requested, the client hard-reloads onto
#     the consistent new build instead of erroring. Empty locally → skew
#     protection off (no forced reload on a version mismatch).
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ARG NEXT_DEPLOYMENT_ID

RUN npm run build

# Bundle the standalone migration entrypoint. The Next standalone runner stage
# carries no full node_modules, so esbuild inlines the migrator's deps (kysely,
# pg, the Cloud SQL connector) into one self-contained CJS file the
# `commcare-nova-migrate` Cloud Run Job runs with `node migrate.cjs`. This
# replaces the former `atlas` binary copied from a separate image. `--tsconfig`
# resolves the `@/*` path alias; `pg-native` is pg's optional native binding
# (lazily required behind a guard) — left external so the bundle doesn't try to
# resolve a module that isn't installed.
RUN npx esbuild scripts/migrate.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --tsconfig=tsconfig.json --external:pg-native \
      --outfile=migrate.cjs

# --- Stage 3: Production runner ---
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Runtime capability declarations are rendered from the checked-in manifest by
# Cloud Build. Baking them and the unique Cloud Build identity into the image
# gives startup health one immutable deployed-image declaration. A local build
# that omits the args fails startup health instead of masquerading as a
# deployable revision.
ARG NOVA_BUILD_ID
ARG NOVA_WRITER_VERSION
ARG NOVA_STREAM_RECEIVER_VERSION
ARG NOVA_RUNTIME_READER_VERSION
ARG NOVA_STREAM_REGISTRY_VERSION
ARG NOVA_CLOUD_RUN_REQUEST_SECONDS
ARG NOVA_STREAM_LEASE_GRACE_SECONDS
ARG NOVA_STREAM_LEASE_TTL_SECONDS
ARG NOVA_EDIT_RUN_LEASE_SECONDS
ARG NOVA_BUILD_STALENESS_SECONDS
ARG NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH
# Preserve a second, file-backed copy so startup health can detect a Cloud Run
# env override instead of accepting a mutable NOVA_BUILD_ID at face value.
RUN printf '%s' "${NOVA_BUILD_ID}" > /app/.nova-build-id
ENV NOVA_BUILD_ID="${NOVA_BUILD_ID}" \
    NOVA_WRITER_VERSION="${NOVA_WRITER_VERSION}" \
    NOVA_STREAM_RECEIVER_VERSION="${NOVA_STREAM_RECEIVER_VERSION}" \
    NOVA_RUNTIME_READER_VERSION="${NOVA_RUNTIME_READER_VERSION}" \
    NOVA_STREAM_REGISTRY_VERSION="${NOVA_STREAM_REGISTRY_VERSION}" \
    NOVA_CLOUD_RUN_REQUEST_SECONDS="${NOVA_CLOUD_RUN_REQUEST_SECONDS}" \
    NOVA_STREAM_LEASE_GRACE_SECONDS="${NOVA_STREAM_LEASE_GRACE_SECONDS}" \
    NOVA_STREAM_LEASE_TTL_SECONDS="${NOVA_STREAM_LEASE_TTL_SECONDS}" \
    NOVA_EDIT_RUN_LEASE_SECONDS="${NOVA_EDIT_RUN_LEASE_SECONDS}" \
    NOVA_BUILD_STALENESS_SECONDS="${NOVA_BUILD_STALENESS_SECONDS}" \
    NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH="${NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH}"

# Don't run as root in production.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output + static/public assets.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Self-contained migration entrypoint. The `commcare-nova-migrate` Cloud Run
# Job reuses THIS image with a `node migrate.cjs` command override, so the
# bundled migrator (kysely + pg + Cloud SQL connector, inlined by esbuild in
# the builder stage) must be present. No external binary and no raw migration
# files — the migration modules are bundled into `migrate.cjs`.
COPY --from=builder --chown=nextjs:nodejs /app/migrate.cjs ./migrate.cjs

USER nextjs

# Cloud Run injects PORT (defaults to 8080).
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"
EXPOSE 8080

# Boot is node-only — migrations do NOT run here. Running migrations on boot
# would put a Cloud SQL connect + migration-lock acquisition on the cold-start
# critical path and serialize concurrent instance startups. The migration runs
# once per deploy via the `commcare-nova-migrate` Cloud Run Job (cloudbuild runs
# it before shifting traffic), so a cold boot is just Node coming up.
#
# The bundled `migrate.cjs` stays in this image on purpose: the migrate Job
# reuses THIS image with a `node migrate.cjs` command override.
#
# Exec-form CMD (no `sh -c` wrapper) makes Node PID 1, so SIGTERM
# from Cloud Run reaches it directly for graceful shutdown.
CMD ["node", "server.js"]
