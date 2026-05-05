-- lib/case-store/schema.sql
--
-- Single source of truth for the case-store relational schema.
-- Atlas reads this file as the desired state, replays it against
-- the inline `docker+postgres://...` dev container described in
-- `atlas.hcl`'s `local` env, and diffs the result against the
-- already-applied set under `lib/case-store/migrations/` to
-- autogenerate the next migration. The file is authored, not
-- generated; the migrations directory is the generated side.
--
-- ## Schema scope
--
-- Four tables make up the case store, all in the `public` schema:
--
--   1. `cases`             — one row per case, across all apps and tenants.
--   2. `case_type_schemas` — JSON Schema documents per (app_id, case_type).
--   3. `case_indices`      — case-relation edges (descendant → ancestor).
--   4. `cases_quarantine`  — failed-migration sink with the same shape
--                            as `cases` plus quarantine metadata.
--
-- Spec citations:
--   - `cases`, `case_type_schemas`, `case_indices` (incl. their two
--     static indexes): `docs/superpowers/specs/2026-04-30-case-list-search-design.md`
--     lines 254-284.
--   - `cases_quarantine` shape (PK + columns): same spec, lines 309-340.
--
-- ## Postgres extensions are not declared here
--
-- The DDL below references no extension types or functions —
-- columns are plain `text`/`uuid`/`jsonb`/`timestamptz` and the
-- only function reference is PG 18's built-in `uuidv7()`. Atlas's
-- dev container therefore needs no extensions to compute the
-- diff against this file.
--
-- The case-store COMPILER STACK depends on three extensions at
-- query time: `pg_trgm` (fuzzy match), `fuzzystrmatch` (phonetic
-- match), `postgis` (within-distance). Production installs them
-- at Cloud SQL provisioning time via Studio under the briefly-
-- opened postgres superuser (Task 0 runbook §Phase 5); the
-- testcontainers harness installs them via the container's own
-- superuser in `globalSetup.ts`. Atlas's dev container installs
-- nothing — it doesn't need to, because this file references no
-- extension surface, and the `docker "postgres" "dev" { ... }`
-- baseline-SQL block that would drive an install is Atlas Pro
-- only (`atlas.hcl` documents the community-edition fallback).
--
-- The extension install is split out of `schema.sql` because
-- `CREATE EXTENSION` requires cloudsqlsuperuser on production
-- Cloud SQL, and the IAM-auth runtime SA atlas authenticates as
-- does not have it. Mirroring that privilege boundary in tests
-- keeps every environment exercising the runtime SA's actual
-- permission set.
--
-- If a future schema.sql adds a `geometry` column or any other
-- extension-typed column, the `composite_schema` data source
-- pattern at `https://atlasgo.io/faq/manage-extension-only` is
-- the canonical community-edition path for splitting extension
-- declarations from the application schema.
--
-- ## Postgres-strict null semantics
--
-- The `properties` column is JSONB. The case store distinguishes
-- three states for any property: "key absent in document", "key
-- present with JSON null", and "key present with empty string".
-- The Postgres operators the case-list compilers emit
-- (`properties ? 'key'`, `properties->>'key' IS NULL`,
-- `properties->>'key' = ''`) preserve all three states; the JSONB
-- column type itself is the open document the JSON Schema
-- validator (in `case_type_schemas`) runs against at every API
-- write. See `lib/case-store/sql/database.ts` for the full
-- discussion.
--
-- ## Lockstep surfaces
--
-- This file (`schema.sql`) is the source of truth for the SQL
-- engine. `lib/case-store/sql/database.ts` is the source of truth
-- for the Kysely TypeScript types. A schema change updates both
-- files in the same commit. Two compile-only tests in
-- `lib/case-store/sql/__tests__/database.test.ts` catch type
-- drift; the harness's smoke tests catch DDL drift on the live
-- engine.

-- ===================================================================
-- `cases` — spec lines 254-265 + Plan 2's `uuidv7()` default lock
-- ===================================================================
--
-- One row per case across every app and tenant. Tenant isolation
-- is the column pair `(app_id, owner_id)`; the application layer
-- funnels every read/write through a `CaseStore` interface that
-- always supplies the owner-id filter at the request boundary
-- (spec § "CaseStore", line 389).
--
-- ### `case_id DEFAULT uuidv7()`
--
-- PG 18 ships a built-in `uuidv7()` function (release 2025-09-25;
-- documented at `https://www.postgresql.org/docs/18/functions-uuid.html`).
-- v7 UUIDs prefix the value with a millisecond Unix timestamp, so
-- case_ids issued in temporal order cluster on B-tree pages —
-- INSERTs touch fewer cold pages than `gen_random_uuid()` (uuidv4)
-- would, and pagination by `(opened_on, case_id)` is naturally
-- close-to-sorted because the timestamp prefix already orders rows
-- by creation time.
--
-- The harness's `imresamu/postgis:18-3.6.1-alpine3.23` image is
-- PG 18 + PostGIS 3.6.1; production Cloud SQL is PG 18.x. Both
-- have `uuidv7()`. A future image regression that drops to PG 17
-- would surface in the harness's smoke tests, not at runtime.
CREATE TABLE "cases" (
  -- Stable case identifier. UUID v7 generated by Postgres when
  -- the caller omits `case_id` on INSERT; explicit values are
  -- accepted verbatim for cross-system traceability with
  -- CCHQ-style case ids.
  "case_id" uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Owning app identifier. Half of the (app_id, owner_id) tenant
  -- isolation pair. TEXT — apps are root-level Firestore documents
  -- whose IDs are application-controlled strings; the case store
  -- mirrors that shape.
  "app_id" text NOT NULL,
  -- The case-type name. Matches the blueprint's `CaseType.id` for
  -- the case type this case belongs to.
  "case_type" text NOT NULL,
  -- The Better Auth user ID of the case owner. Half of the
  -- (app_id, owner_id) tenant-isolation pair. Nullable — cases
  -- can exist without an explicit owner during intermediate
  -- states (HQ-imported cases pre-assignment, sample-data
  -- fixtures keyed only by app).
  "owner_id" text,
  -- Open / closed status string. Distinct from `closed_on` so that
  -- domain-specific status vocabularies (e.g. CommCare's
  -- `open` / `closed` tokens) round-trip without lossy derivation
  -- from a timestamp.
  "status" text,
  -- Domain timestamp: when the case was opened. Distinct from any
  -- database-housekeeping timestamp; `opened_on` is the value the
  -- case-list "Date Opened" column reads.
  "opened_on" timestamptz,
  -- Domain timestamp: most recent modification. Updated on every
  -- form-submission write through the case store.
  "modified_on" timestamptz,
  -- Domain timestamp: when the case was closed. Null while open.
  -- The standard "list open cases" query is
  -- `WHERE closed_on IS NULL`.
  "closed_on" timestamptz,
  -- Denormalized first-parent identifier. Convenience column for
  -- the common single-parent case — full ancestor walks go through
  -- `case_indices`. Nullable for orphan cases.
  "parent_case_id" uuid,
  -- The case-property document. Validated against the
  -- case_type_schemas[app_id, case_type] JSON Schema by the
  -- case-store's TypeScript validator (`ajv`) at every API-route
  -- write. The API route is the trust boundary; the database is
  -- internal and carries no validation trigger. The Term compiler
  -- reads values via `properties->>'key'` with a per-property
  -- cast keyed on the JSON Schema's declared `data_type`.
  "properties" jsonb NOT NULL
);

-- ===================================================================
-- `case_type_schemas` — spec lines 267-272
-- ===================================================================
--
-- Per-(app_id, case_type) JSON Schema. Generated by
-- `lib/domain/predicate/jsonSchema.ts` from the blueprint's
-- `CaseType.properties[]`. The case-store's TypeScript validator
-- runs `ajv` against this row on every API-route write to `cases`;
-- there is no in-database trigger.
--
-- The (app_id, case_type) PK matches the canonical lookup key —
-- every read of this table is parameterized by the case's owning
-- app and its declared type.
CREATE TABLE "case_type_schemas" (
  -- Owning app identifier. First half of the composite primary key.
  "app_id" text NOT NULL,
  -- The case-type name. Second half — together (app_id, case_type)
  -- is unique.
  "case_type" text NOT NULL,
  -- The JSON Schema document describing the property surface for
  -- this case type. Open `Record<string, JsonValue>` shape; pinning
  -- to a specific Schema-Draft TypeScript type would couple the
  -- table to a particular validator library.
  "schema" jsonb NOT NULL,
  CONSTRAINT "case_type_schemas_pkey" PRIMARY KEY ("app_id", "case_type")
);

-- ===================================================================
-- `case_indices` — spec lines 274-283
-- ===================================================================
--
-- Case-relation edges. One row per direct ancestor edge (depth=1)
-- under the spec § "case_indices materialization policy" Option B
-- (line 295). Multi-hop traversals compose as a chain of
-- `(case_indices, cases)` joins, one per AST step (see
-- `lib/case-store/sql/compileRelationPath.ts`). The architectural
-- answer to CCHQ's `MAX_RELATED_CASES = 500_000` per-hop scan: a
-- single indexed lookup on `(case_id, identifier)` resolves each
-- hop, and the chain stays statically known from the AST so no
-- recursion is needed.
CREATE TABLE "case_indices" (
  -- The descendant case in the relation edge. Foreign key to
  -- `cases.case_id`.
  "case_id" uuid NOT NULL,
  -- The ancestor case in the relation edge. Foreign key to
  -- `cases.case_id`.
  "ancestor_id" uuid NOT NULL,
  -- The relation name. `parent`, `host`, or any custom identifier
  -- the blueprint defines. Open string — applications coin custom
  -- relation names freely.
  "identifier" text NOT NULL,
  -- The kind of relation edge: 'child' (standard parent-child) or
  -- 'extension' (host-extension where closing the host closes the
  -- extension). The explicit relationship column lets the Postgres
  -- compiler answer direction-specific queries the wire grammars
  -- can't express.
  "relationship" text NOT NULL,
  -- Edge depth. `depth=1` means a direct edge; higher values are
  -- reserved for storing transitive edges (Option A in the
  -- materialization policy). The relation-path compiler chains
  -- direct edges per AST step and pins every `case_indices` lookup
  -- to `depth = 1`, so the SQL is materialization-agnostic.
  "depth" integer NOT NULL,
  CONSTRAINT "case_indices_pkey" PRIMARY KEY ("case_id", "ancestor_id", "identifier")
);

-- The two static `case_indices` indexes from spec lines 282-283.
-- Names follow Postgres's default `<table>_<col1>_<col2>_idx`
-- shape so they're recognizable in `pg_indexes` without extra
-- cross-referencing.
--
-- Why these two:
--   - `(ancestor_id, identifier)` covers the ancestor-side lookup
--     the `subcase-exists` operator uses ("find every case whose
--     ancestor is X via identifier Y"). The PK leads with `case_id`,
--     so without this index the lookup degrades to a sequential scan.
--   - `(case_id, identifier)` covers the relation-walk leaf join in
--     the `compileRelationPath` chain, where the AST specifies an
--     identifier but the lookup is on the descendant side.
--
-- Per-property expression indexes (Plan 2's dynamic-index discipline)
-- are NOT in this static schema. Property names are blueprint-
-- specific and search modes are search-input-config-specific; the
-- canonical owner is `applySchemaChange`, which maintains the
-- matching CREATE INDEX / DROP INDEX set in the same transaction
-- as the JSON Schema regen.
CREATE INDEX "case_indices_ancestor_id_identifier_idx"
  ON "case_indices" ("ancestor_id", "identifier");

-- Column order `(case_id, identifier)` (NOT the reverse) matters:
-- the relation-walk composer's leaf join filters on `case_id`
-- first (the parent-side row) and uses `identifier` to
-- disambiguate (the relation name). Leading on `case_id` lets the
-- planner narrow on the parent before checking the relation.
CREATE INDEX "case_indices_case_id_identifier_idx"
  ON "case_indices" ("case_id", "identifier");

-- ===================================================================
-- `cases_quarantine` — spec § "Schema migration policy" lines 309-340
-- ===================================================================
--
-- Failed-migration sink. `applySchemaChange` writes a row here
-- whenever a blueprint mutation produces a value the new schema
-- rejects (a `data_type` change that can't cast, a `single_select`
-- option removal that orphans existing values). The original row
-- stays preserved verbatim alongside the failure reason so the
-- author UI can surface the conflict for review and
-- resolution.
--
-- The shape is `cases`'s columns plus two quarantine-specific
-- additions. `case_id` here is NOT defaulted — quarantine writes
-- always carry the original `case_id` of the source row so the
-- quarantine record is traceable back to the live row.
--
-- ### Composite primary key `(case_id, quarantined_at)`
--
-- A single case_id can be quarantined more than once across
-- migrations (e.g. a retype quarantines the row in migration A,
-- the author edits the blueprint, a second retype quarantines it
-- again in migration B against the still-incompatible value).
-- Pinning the PK on `case_id` alone would conflict on the second
-- quarantine; the composite key admits the multi-version history
-- without collision and the `quarantined_at` default handles
-- uniqueness within the same transaction (the timestamp resolves
-- at INSERT time and a single migration writes each row once).
--
-- ### No indexes beyond the PK
--
-- Quarantine rows are read by author UI for review — not on the
-- case-list hot path. Adding the same `(app_id, case_type)` /
-- `case_indices` parallel indexes would double the write cost
-- during migration without payoff. If profiling later shows
-- author-side review is slow, add targeted indexes then.
CREATE TABLE "cases_quarantine" (
  -- The case_id of the row that was quarantined. NOT defaulted;
  -- quarantine writes always carry the original case_id of the
  -- source row.
  "case_id" uuid NOT NULL,
  -- Mirrors `cases.app_id` — quarantine rows are per-tenant the
  -- same way live rows are.
  "app_id" text NOT NULL,
  -- The case-type the row belonged to at quarantine time. For a
  -- property-type-change quarantine this is the case-type whose
  -- schema rejected the row.
  "case_type" text NOT NULL,
  -- Mirrors `cases.owner_id` — nullable for the same reasons.
  "owner_id" text,
  -- Mirrors `cases.status`.
  "status" text,
  -- Mirrors `cases.opened_on`.
  "opened_on" timestamptz,
  -- Mirrors `cases.modified_on`.
  "modified_on" timestamptz,
  -- Mirrors `cases.closed_on`.
  "closed_on" timestamptz,
  -- Mirrors `cases.parent_case_id`.
  "parent_case_id" uuid,
  -- The `cases.properties` JSONB document captured verbatim at
  -- quarantine time. Preserved (not normalized to the new schema)
  -- so the author UI can display the conflicting value for
  -- resolution.
  "properties" jsonb NOT NULL,
  -- Free-text failure reason. Authored by the migration code that
  -- performed the quarantine; e.g. "cast text→int failed for
  -- property 'age': value 'abc' is not numeric" or "option 'red'
  -- removed from single_select 'color'".
  "quarantine_reason" text NOT NULL,
  -- When the row was quarantined. Defaulted server-side so
  -- application code omits the column on INSERT and relies on the
  -- database to stamp a monotonic value.
  "quarantined_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cases_quarantine_pkey" PRIMARY KEY ("case_id", "quarantined_at")
);
