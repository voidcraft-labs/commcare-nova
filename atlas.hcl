# atlas.hcl
#
# Atlas project configuration for the case-store schema.
#
# Atlas is the migration tool. It reads `lib/case-store/schema.sql`
# as the desired state, replays the applied migrations under
# `lib/case-store/migrations/` against a dev container to compute
# the current state, and generates new migration files that move
# the database from current to desired. The generated migrations
# are committed verbatim — they are the contract the production
# Cloud Run startup CMD applies against the live Cloud SQL instance.
#
# Three envs:
#
#   - `local`        — developer laptop. `atlas migrate diff` and
#                      `atlas migrate lint` run against the inline
#                      dev container URL below.
#   - `testcontainer` — the testcontainers harness's
#                      `globalSetup.ts` shells out to
#                      `atlas migrate apply --env testcontainer
#                      --url <testcontainer-uri>`. Same migration
#                      directory the production env applies; the
#                      harness URL is supplied externally because
#                      the testcontainer's port is dynamic.
#   - `prod`         — Cloud Run startup CMD. `atlas migrate apply
#                      --env prod` runs against the live Cloud SQL
#                      instance over Direct VPC Egress, with IAM
#                      authentication via Atlas's
#                      `gcp_cloudsql_token` data source.
#
# Atlas's apply command holds a Postgres advisory lock for the
# duration of a migration run, so concurrent Cloud Run instance
# startups serialize cleanly — only the first instance applies; the
# others wait for the lock then no-op (no pending migrations).
# Lock name `atlas_migrate_execute` is the documented default.

# -----------------------------------------------------------------
# Dev container — `docker+postgres://...` inline URL
# -----------------------------------------------------------------
#
# Atlas needs a Postgres dev database to replay migrations against
# when computing diff or running lint. Atlas's `docker "postgres"
# "dev" { ... }` named-block syntax is Pro-only (verified
# empirically against community v1.2.1: "atlas.hcl: Unsupported
# attribute named 'url'" when referencing `docker.postgres.dev.url`
# from an env's `dev` attribute). The community-edition path is
# `docker+postgres://<image>/<schema>` as an inline URL.
#
# The image name matches the testcontainers harness's pinned image
# at `lib/case-store/sql/__tests__/globalSetup.ts` (PG 18 + PostGIS
# 3.6.1, multi-arch including linux/arm64). Tag form (no @sha256
# digest) is intentional: the dev container is ephemeral and exists
# only to compute the diff. The harness's digest pin is the
# supply-chain boundary that matters; this container never runs
# application queries.
#
# ### Extensions and the dev container
#
# The dev container needs no extensions to compute the diff:
# `schema.sql` references no extension types or functions — all
# columns are plain text/uuid/jsonb/timestamptz and the only
# function reference is `uuidv7()` (PG 18 built-in). The diff
# runs cleanly against the vanilla PostGIS-enabled image.
#
# Adding an extension-typed column (e.g. a `geometry` column for
# a materialized geo index) would require the `composite_schema`
# data source pattern at
# `https://atlasgo.io/faq/manage-extension-only` to split the
# extension declarations out of the application schema; the
# community-edition `docker { baseline = ... }` block that would
# otherwise install extensions at dev-container boot is Atlas Pro
# only.
#
# `pg_trgm` / `fuzzystrmatch` / `postgis` are installed at
# Cloud SQL provisioning time under the built-in `postgres`
# superuser (`CREATE EXTENSION` requires `cloudsqlsuperuser`,
# and the runtime IAM SA atlas runs as does not carry that
# role); the testcontainers harness installs the same set via
# `globalSetup.ts` under its container's superuser. Both paths
# get the extensions in place before atlas runs any application
# query against the database.

# -----------------------------------------------------------------
# Local dev URL — shared between `local` and `testcontainer` envs
# -----------------------------------------------------------------
#
# Both envs reference the same dev container. Pulling the URL
# string into a `locals` block keeps the two envs in sync at edit
# time — a future image bump touches one line, not two.
locals {
  dev_url = "docker+postgres://imresamu/postgis:18-3.6.1-alpine3.23/dev?search_path=public"
}

# -----------------------------------------------------------------
# `local` env — developer laptop diff/lint
# -----------------------------------------------------------------
#
# The npm scripts `db:diff` and `db:lint` invoke this env via
# `--env local`. Both commands use the dev container above; neither
# touches a real database.
#
# ### Diff policy — destructive changes are auto-skipped
#
# `diff { skip { ... } }` tells Atlas not to emit DROP statements
# during diff generation. Auto-skipping at diff time means a
# developer who removes a column from `schema.sql` will get an
# empty diff — a loud signal that the contract migration must be
# authored manually as a separate file after the expand migration
# ships.
#
# ### Lint policy — destructive changes error in CI
#
# `lint { destructive { error = true } }` is the safety net for the
# auto-skip: if a destructive statement somehow lands in a generated
# migration (a manual edit, a future Atlas behavior change), `atlas
# migrate lint` exits non-zero and the lefthook pre-commit hook
# blocks the commit. The combined effect — auto-skip at diff time +
# destructive-error at lint time — forces destructive schema changes
# (column / table / schema removal) through expand-contract across
# multiple deploys: ship the additive expand migration first, cut
# application code over to the new surface in a second deploy, then
# author the contract migration manually as a separate file once the
# old surface has no live readers.
env "local" {
  src = "file://lib/case-store/schema.sql"
  dev = local.dev_url
  migration {
    dir = "file://lib/case-store/migrations"
  }
  diff {
    skip {
      drop_schema = true
      drop_table  = true
      drop_column = true
    }
  }
  lint {
    destructive {
      error = true
    }
  }
}

# -----------------------------------------------------------------
# `testcontainer` env — Vitest globalSetup harness
# -----------------------------------------------------------------
#
# `lib/case-store/sql/__tests__/applyMigrationsViaAtlas.ts` shells
# out to `atlas migrate apply --env testcontainer --url <uri>
# --allow-dirty` against testcontainers booted by `globalSetup.ts`
# and per-test databases provisioned by `setupPerTestDatabase`.
# `--allow-dirty` suppresses Atlas's empty-database precondition
# check — postgis is pre-installed in the harness's image, so the
# `tiger` and `topology` schemas are non-empty before Atlas runs;
# without the flag, Atlas would refuse to apply against a
# "non-empty" database.
#
# The `--url` flag overrides the env's URL (which has no static
# value here; the testcontainer's port is dynamic per run). The
# `migration { dir = ... }` configuration is what Atlas actually
# consumes — it points at the same `lib/case-store/migrations`
# directory `prod` applies, so tests exercise the exact migration
# set production ships.
#
# `src` lets `atlas migrate diff` and `atlas migrate lint` operate
# from this env against a testcontainer URI; day-to-day only
# `migrate apply` runs here.
env "testcontainer" {
  src = "file://lib/case-store/schema.sql"
  dev = local.dev_url
  migration {
    dir = "file://lib/case-store/migrations"
  }
}

# -----------------------------------------------------------------
# `prod` env — Cloud Run startup CMD
# -----------------------------------------------------------------
#
# The Dockerfile's CMD chains `atlas migrate apply --env prod &&
# exec node server.js`. Atlas runs first, applies any pending
# migrations against the live Cloud SQL instance, and only on
# success does Next.js boot. Failure exits non-zero and the Cloud
# Run instance never serves traffic.
#
# ### URL composition
#
# Atlas connects to Cloud SQL over Direct VPC Egress + private IP
# using a standard `postgres://` URL. The three env vars are wired
# on the Cloud Run revision:
#
#   - NOVA_DB_USER     — IAM service-account identity in Cloud SQL's
#                        truncated form (`51003905459-compute@developer`).
#   - NOVA_DB_HOST     — private IPv4 address of the Cloud SQL
#                        instance (10.9.160.3). Atlas can't resolve an
#                        instance-connection-name the way
#                        `@google-cloud/cloud-sql-connector` does — it
#                        speaks raw `postgres://` only, so the host
#                        must be a literal address.
#   - NOVA_DB_NAME     — application database name (`nova_cases`).
#
# Application code (`lib/case-store/postgres/connection.ts`)
# continues to read `NOVA_DB_INSTANCE_CONNECTION_NAME` (not used by
# atlas) and authenticates via `@google-cloud/cloud-sql-connector`.
# The two paths share the same Cloud SQL instance and the same IAM
# user; they differ only in how each tool resolves the network
# endpoint. Pinning the private IP via `NOVA_DB_HOST` is acceptable
# because the IP is stable for the instance's lifetime — Cloud SQL
# Postgres reserves the address from the VPC peering range when the
# instance is created.
#
# ### IAM authentication via `gcp_cloudsql_token`
#
# Atlas's `gcp_cloudsql_token` data source uses Application Default
# Credentials (the Cloud Run runtime SA) to mint a short-lived IAM
# token. The token replaces the password slot in the URL; Postgres
# accepts it because the IAM user (`NOVA_DB_USER`) was created with
# `--type=CLOUD_IAM_SERVICE_ACCOUNT` and the instance has
# `cloudsql.iam_authentication=on` — the two server-side
# preconditions IAM-token authentication relies on.
#
# `urlescape()` is required on both userinfo components.
# `NOVA_DB_USER` is `<account-id>-compute@developer` — the `@`
# before `developer` is a sub-delim that RFC 3986 requires
# percent-encoded inside the userinfo component (where the
# top-level `@` separates userinfo from the host). `gcp_cloudsql_token`
# emits a JWT-shaped IAM access token whose body and signature
# segments contain `=` (base64 padding), `+`, and `/` characters
# — all sub-delims in the userinfo component per RFC 3986. Most
# parsers tolerate the unescaped form by anchoring on the
# right-most `@`, but escaping both sides removes the parser-
# tolerance dependency.
#
# `sslmode=require` matches Cloud SQL's enforced TLS posture; the
# Postgres driver uses the system root store to verify the server
# certificate.
data "gcp_cloudsql_token" "db" {}

env "prod" {
  url = "postgres://${urlescape(getenv("NOVA_DB_USER"))}:${urlescape(data.gcp_cloudsql_token.db)}@${getenv("NOVA_DB_HOST")}:5432/${getenv("NOVA_DB_NAME")}?sslmode=require"
  migration {
    dir = "file://lib/case-store/migrations"
  }
}
