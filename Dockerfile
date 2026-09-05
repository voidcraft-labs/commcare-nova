# syntax=docker/dockerfile:1.10.0
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
# 24.18.1 is the LTS runtime and is new enough for independently pinned npm 12.
#
# `.nvmrc` is the canonical Node version (CI reads it via `node-version-file`,
# local nvm/fnm read it directly). Keep this patch in lockstep with it — the
# `quality` CI job fails if `.nvmrc` and this ARG drift.
ARG NODE_IMAGE=node:24.18.1-alpine
ARG NPM_VERSION=12.0.2

# Dependency layers are independent of source and per-release identity.
FROM ${NODE_IMAGE} AS build-base
ARG NPM_VERSION
RUN --mount=type=cache,id=nova-npm-downloads,target=/root/.npm \
    npm install --global "npm@${NPM_VERSION}" --ignore-scripts --no-audit --no-fund && \
    test "$(npm --version)" = "${NPM_VERSION}"

FROM build-base AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Download archives are disposable, not a second copy of node_modules in the
# exported dependency layer. A fresh worker still installs from the lockfile.
RUN --mount=type=cache,id=nova-npm-downloads,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

# Inherit dependency layers instead of copying the full node_modules tree.
FROM deps AS sources
COPY . .
RUN node scripts/harden-agent-react-devtools.mjs

FROM sources AS migration-build
RUN npx esbuild scripts/migrate.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=migrate.cjs && touch -t 197001010000 migrate.cjs

FROM sources AS capture-build
RUN npx esbuild scripts/cleanup-form-attachments.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=capture-cleanup.cjs && touch -t 197001010000 capture-cleanup.cjs

# Job artifacts have their own identity. An application build UUID must not
# turn unchanged migration or recurring-worker code into a new Job artifact.
FROM ${NODE_IMAGE} AS job-runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
USER nextjs

FROM job-runtime AS migration
COPY --from=migration-build --chown=nextjs:nodejs /app/migrate.cjs ./migrate.cjs
CMD ["node", "migrate.cjs"]

FROM job-runtime AS capture-worker
COPY --from=capture-build --chown=nextjs:nodejs /app/capture-cleanup.cjs ./capture-cleanup.cjs
CMD ["node", "capture-cleanup.cjs"]

# Explicit operator build only; not an ancestor of the application runner.
FROM sources AS maintenance-build
RUN npx esbuild scripts/audit-canonical-identity-foundation.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=canonical-identity-audit.cjs
RUN npx esbuild scripts/infra/apply-media-bucket-policy.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=media-bucket-policy.cjs
RUN npx esbuild scripts/migrate-case-type-schema-retirement.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=case-type-schema-retirement.cjs
RUN npx esbuild scripts/migrate-case-parent-relationships.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=case-parent-relationship-repair.cjs
RUN npx esbuild scripts/migrate-schema-drift.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=schema-drift.cjs
RUN npx esbuild scripts/migrate-legacy-preplan-builds.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=legacy-preplan-repair.cjs
RUN npx esbuild scripts/migrate-language-identity.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=language-identity-repair.cjs
RUN npx esbuild scripts/migrate-case-status-filters.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=case-status-filter-repair.cjs
RUN npx esbuild scripts/migrate-better-auth-account-identity.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=better-auth-account-identity.cjs
RUN npx esbuild scripts/migrate-better-auth-oauth-clients.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=better-auth-oauth-clients.cjs
RUN npx esbuild scripts/migrate-select-option-values.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=select-option-value-repair.cjs

FROM ${NODE_IMAGE} AS maintenance
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=maintenance-build --chown=nextjs:nodejs /app/*.cjs ./
USER nextjs
# Safe default: the repair CLI scans unless an operator explicitly executes it.
CMD ["node", "legacy-preplan-repair.cjs"]

# The registry seed is copied directly inside BuildKit into its writable cache
# mount. It never passes through the build context or an application layer.
FROM ${NODE_IMAGE} AS cache-seed
RUN --mount=type=bind,from=next-cache,target=/seed \
    --mount=type=cache,id=nova-next-cache,target=/cache \
    test -z "$(find /seed ! -type f ! -type d -print -quit)" && \
    test "$(du -sk /seed | cut -f1)" -le 2097152 && \
    rm -rf /cache/* /cache/.[!.]* /cache/..?* && \
    cp -a /seed/. /cache/ && touch /cache-ready

FROM sources AS builder
COPY --from=cache-seed /cache-ready /cache-ready
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true
ARG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
ARG NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
ARG NEXT_DEPLOYMENT_ID
ARG NOVA_BUILD_ID
ENV NOVA_BUILD_ID="${NOVA_BUILD_ID}" \
    NEXT_PUBLIC_NOVA_BUILD_ID="${NOVA_BUILD_ID}"

# Next 16.3 and the native type checker share only their incremental cache.
# BuildKit excludes the cache mount from the application's build layer.
# Secrets are ephemeral mounts, not ARGs in exported BuildKit cache metadata.
RUN --mount=type=cache,id=nova-next-cache,target=/app/.next/cache \
    --mount=type=secret,id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN \
    --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,required=true \
    npm run build

# Publish one directly downloadable corresponding-source archive for the
# OpenJDK-derived browser runtime. Preserve repo-root-relative paths so the
# included build + verification entrypoints work when the archive is extracted
# over a Nova checkout. The public matcher exemption makes this compliance
# artifact reachable without an authenticated application session.
RUN mkdir -p public/third-party && \
    tar -czf public/third-party/java-pattern-runtime-source.tar.gz \
      scripts/java-pattern-runtime \
      lib/preview/xpath/openJdk17DoubleString.ts \
      lib/preview/xpath/vendor/javaMathRuntime.generated.js \
      lib/preview/xpath/vendor/javaMathRuntime.generated.d.ts \
      lib/preview/xpath/vendor/javaPatternRuntime.generated.js \
      lib/preview/xpath/vendor/javaPatternRuntime.generated.d.ts \
      lib/preview/xpath/vendor/javaPatternNames.generated.ts


# This is exported separately while deployment runs. The completion dependency
# prevents publishing a partial compiler cache. No application artifacts enter
# this private cache image.
FROM ${NODE_IMAGE} AS cache-snapshot
COPY --from=builder /app/.next/BUILD_ID /build-complete
RUN --mount=type=cache,id=nova-next-cache,target=/cache \
    test "$(du -sk /cache | cut -f1)" -le 2097152 && cp -a /cache /output

FROM scratch AS next-cache-export
COPY --from=cache-snapshot /output/ /

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
ARG NOVA_CLOUD_RUN_REQUEST_SECONDS
ARG NOVA_EDIT_RUN_LEASE_SECONDS
ARG NOVA_BUILD_STALENESS_SECONDS
ARG NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH
# Preserve a second, file-backed copy so startup health can detect a Cloud Run
# env override instead of accepting a mutable NOVA_BUILD_ID at face value.
RUN printf '%s' "${NOVA_BUILD_ID}" > /app/.nova-build-id
ENV NOVA_BUILD_ID="${NOVA_BUILD_ID}" \
    NOVA_CLOUD_RUN_REQUEST_SECONDS="${NOVA_CLOUD_RUN_REQUEST_SECONDS}" \
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

# sharp's prebuilt libvips (@img/sharp-libvips-*) is loaded via dlopen from
# the binding's RPATH, never require()d, so Next's standalone file tracing
# cannot see it and the traced node_modules ships the binding without the
# shared library it needs. Copy the platform's @img tree explicitly.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img

USER nextjs

# Cloud Run injects PORT (defaults to 8080).
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"
EXPOSE 8080

# Boot is node-only — migrations do NOT run here. Running migrations on boot
# would put a Cloud SQL connect + migration-lock acquisition on the cold-start
# critical path and serialize concurrent instance startups. The migration runs
# through the independently identified migration image when its content
# changes. Cloud Build proves its successful execution before shifting traffic.
#
# Exec-form CMD (no `sh -c` wrapper) makes Node PID 1, so SIGTERM
# from Cloud Run reaches it directly for graceful shutdown.
CMD ["node", "server.js"]
