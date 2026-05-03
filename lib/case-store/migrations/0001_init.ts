// lib/case-store/migrations/0001_init.ts
//
// Initial schema migration. Creates the four tables that make up
// the case store: `cases`, `case_type_schemas`, `case_indices`, and
// `cases_quarantine`. Verbatim against the spec's "Storage layer
// for cases" DDL block at
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`
// lines 249-284 plus the `cases_quarantine` shape from the same
// spec's "Schema migration policy" section at lines 309-340.
//
// ## Migration file format — Kysely `Migration` interface
//
// Per Kysely's documented canonical migration pattern at
// `https://kysely.dev/docs/migrations`, migration files export
// `up` and `down` async functions taking `Kysely<any>`. The
// signature is intentionally loose — migrations run against a
// schema that is mid-creation (the application's `Database` type
// won't match a database with an empty schema), so a concrete
// type would create a false compile-time guarantee.
//
// The format is `.ts` modules — the typed schema builder
// (`db.schema.createTable(...).addColumn(...)`) catches
// column-name typos that raw `.sql` files never could, and the
// same module runs in production (compiled to JS by
// `Dockerfile.migrate`) and in tests (loaded by Vitest's
// transform via `FileMigrationProvider`'s dynamic import). The
// migrations folder carries a scoped `package.json` declaring
// `"type": "module"` so Node treats every `.ts` here as ESM
// without affecting the root project's CommonJS expectation.
//
// ## `case_id` default — `uuidv7()`
//
// PG 18 ships a built-in `uuidv7()` function (release 2025-09-25;
// signature documented at
// `https://www.postgresql.org/docs/18/functions-uuid.html`) that
// returns a time-ordered v7 UUID. The first 48 bits are the
// millisecond Unix timestamp, so case_ids issued in temporal
// order cluster on B-tree pages — INSERTs touch fewer cold pages
// than `gen_random_uuid()` (uuidv4) would, and pagination by
// `(opened_on, case_id)` is naturally close-to-sorted because the
// timestamp prefix already orders rows by creation time.
//
// The harness's `imresamu/postgis:18-3.6.1-alpine3.23` image is
// PG 18 + PostGIS 3.6.1; production Cloud SQL is PG 18.x with
// PostGIS 3.6.0. Both have `uuidv7()`. The migration smoke test
// in `__tests__/runner.test.ts` issues an INSERT without a
// `case_id` column and asserts the returned value is a valid
// UUID with version nibble = 7, so a future image regression
// surfaces here, not at runtime.
//
// ## `cases_quarantine` shape
//
// Same column shape as `cases` plus two additional columns:
//
//   - `quarantine_reason TEXT NOT NULL` — the cast-failure detail
//     or the narrowed-option value that disqualified the row.
//     Required so author-facing review UI always has a reason
//     to show.
//   - `quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now()` —
//     when the row was quarantined. Defaulted server-side so
//     `applySchemaChange` doesn't need to compute it client-
//     side and the value is monotonic per-server.
//
// **Primary key.** `(case_id, quarantined_at)`. A single case_id
// can be quarantined more than once across migrations (e.g. a
// retype quarantines the row in migration A, the author edits
// the blueprint, a second retype quarantines it again in
// migration B against the still-incompatible value). Pinning
// the PK on `case_id` alone would conflict on the second
// quarantine; the composite key admits the multi-version history
// without collision and the `quarantined_at` default handles
// uniqueness within the same transaction (the timestamp resolves
// at INSERT time and a single migration writes each row once).
//
// **No indexes beyond the PK.** Quarantine rows are read by
// author UI for review — not on the case-list hot path. Adding
// the same `(app_id, case_type)` / `case_indices` parallel
// indexes would double the write cost during migration without
// payoff. If profiling later shows author-side review is slow,
// add targeted indexes then.

import { type Kysely, sql } from "kysely";

/**
 * Apply the initial schema. Creates the four case-store tables in
 * dependency order: `cases` first (`case_indices` and
 * `cases_quarantine` reference its `case_id` shape), then the
 * three siblings.
 *
 * The schema builder's `addColumn` calls compose typed column-
 * shape declarations Kysely lowers to dialect-specific DDL. For
 * Postgres the `defaultTo(sql\`uuidv7()\`)` shape compiles to
 * `DEFAULT uuidv7()`; the `sql\`...\`` template wrapper is the
 * documented Kysely path for a function-call default value (the
 * `defaultTo` argument is typed as a value or `Expression`, and a
 * function call composes through `sql` — verified at
 * `https://kysely.dev/docs/migrations`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// -------------------------------------------------------------------
	// `cases` — spec lines 254-265 + Plan 2's `uuidv7()` default lock
	// -------------------------------------------------------------------
	//
	// `case_id` defaults to `uuidv7()` so the application can
	// INSERT without supplying a value — the database controls
	// the time-ordered prefix and the typed-builder layer can
	// capture the generated id via `RETURNING case_id`.
	await db.schema
		.createTable("cases")
		.addColumn("case_id", "uuid", (col) =>
			col.primaryKey().defaultTo(sql`uuidv7()`),
		)
		.addColumn("app_id", "text", (col) => col.notNull())
		.addColumn("case_type", "text", (col) => col.notNull())
		.addColumn("owner_id", "text")
		.addColumn("status", "text")
		.addColumn("opened_on", "timestamptz")
		.addColumn("modified_on", "timestamptz")
		.addColumn("closed_on", "timestamptz")
		.addColumn("parent_case_id", "uuid")
		.addColumn("properties", "jsonb", (col) => col.notNull())
		.execute();

	// -------------------------------------------------------------------
	// `case_type_schemas` — spec lines 267-272
	// -------------------------------------------------------------------
	await db.schema
		.createTable("case_type_schemas")
		.addColumn("app_id", "text", (col) => col.notNull())
		.addColumn("case_type", "text", (col) => col.notNull())
		.addColumn("schema", "jsonb", (col) => col.notNull())
		.addPrimaryKeyConstraint("case_type_schemas_pkey", ["app_id", "case_type"])
		.execute();

	// -------------------------------------------------------------------
	// `case_indices` — spec lines 274-280 (the per-spec indexes are in
	// `0002_indices.ts`; this migration creates the table only).
	// -------------------------------------------------------------------
	await db.schema
		.createTable("case_indices")
		.addColumn("case_id", "uuid", (col) => col.notNull())
		.addColumn("ancestor_id", "uuid", (col) => col.notNull())
		.addColumn("identifier", "text", (col) => col.notNull())
		.addColumn("relationship", "text", (col) => col.notNull())
		.addColumn("depth", "integer", (col) => col.notNull())
		.addPrimaryKeyConstraint("case_indices_pkey", [
			"case_id",
			"ancestor_id",
			"identifier",
		])
		.execute();

	// -------------------------------------------------------------------
	// `cases_quarantine` — spec § "Schema migration policy" (lines 309-340)
	//
	// Same column set as `cases` plus `quarantine_reason` +
	// `quarantined_at`. The `case_id` column does NOT default to
	// `uuidv7()` — quarantine writes always carry the original
	// `case_id` of the row that failed migration so the
	// quarantine record is traceable back to the source row.
	// -------------------------------------------------------------------
	await db.schema
		.createTable("cases_quarantine")
		.addColumn("case_id", "uuid", (col) => col.notNull())
		.addColumn("app_id", "text", (col) => col.notNull())
		.addColumn("case_type", "text", (col) => col.notNull())
		.addColumn("owner_id", "text")
		.addColumn("status", "text")
		.addColumn("opened_on", "timestamptz")
		.addColumn("modified_on", "timestamptz")
		.addColumn("closed_on", "timestamptz")
		.addColumn("parent_case_id", "uuid")
		.addColumn("properties", "jsonb", (col) => col.notNull())
		.addColumn("quarantine_reason", "text", (col) => col.notNull())
		.addColumn("quarantined_at", "timestamptz", (col) =>
			col.notNull().defaultTo(sql`now()`),
		)
		.addPrimaryKeyConstraint("cases_quarantine_pkey", [
			"case_id",
			"quarantined_at",
		])
		.execute();
}

/**
 * Roll back the initial schema. Drops the four tables in reverse
 * dependency order (sibling tables first, then `cases`). Each
 * drop is unconditional — Kysely's migrator only invokes `down`
 * against a database whose `kysely_migration` ledger records
 * this migration as applied, so an `IF EXISTS` guard would mask
 * a regression that left the schema half-applied.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("cases_quarantine").execute();
	await db.schema.dropTable("case_indices").execute();
	await db.schema.dropTable("case_type_schemas").execute();
	await db.schema.dropTable("cases").execute();
}
