// lib/case-store/migrations/0002_indices.ts
//
// Static `case_indices` indexes from the spec's "Storage layer
// for cases" DDL block at
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`
// lines 282-283.
//
// ## Why these indexes specifically
//
// Spec line 280's primary key on `(case_id, ancestor_id,
// identifier)` already gives the descendant-side lookup a
// covering index. The two indexes below cover the two query
// shapes the predicate compiler emits that don't hit the PK:
//
//   - `(ancestor_id, identifier)` — the ancestor-side lookup the
//     `subcase-exists` operator uses ("find every case whose
//     ancestor is X via identifier Y"). The PK leads with
//     `case_id`, so without this index the lookup degrades to a
//     sequential scan.
//   - `(case_id, identifier)` — covers the relation-walk leaf
//     join in the `compileRelationPath` chain, where the AST
//     specifies an identifier but the lookup is on the
//     descendant side. The PK's `case_id` prefix narrows the
//     search but doesn't index by identifier directly; the
//     two-column index lets the planner use index-only scans
//     for the join.
//
// ## What this migration does NOT contain — per-property
// expression indexes
//
// Plan 2's per-property expression-index discipline (the table
// at the top of `docs/superpowers/plans/2026-05-01-case-data-layer.md`
// lines 18-29) is structurally OUT OF SCOPE for any static
// migration. The property name is dynamic per blueprint and the
// search mode is dynamic per Plan 4 search-input config; the
// canonical owner of those indexes is `applySchemaChange`
// (Plan 2 Task 8), which reads the union of (case-type
// properties × search-input modes) from the current blueprint
// and emits the matching `CREATE INDEX` / `DROP INDEX` set in
// the same transaction as the JSON Schema regen.
//
// A static migration adding per-property indexes here would lock
// the index set at migration time — every blueprint mutation
// thereafter would create a divergence the dynamic owner can't
// recover. Keep this migration to the per-spec, structurally-
// stable shape only.

import type { Kysely } from "kysely";

/**
 * Apply the two static `case_indices` indexes from spec lines
 * 282-283. Both are unique-by-spec-citation; the names below
 * follow Postgres's default `<table>_<col1>_<col2>_idx` shape so
 * they're recognizable in `pg_indexes` without extra cross-
 * referencing.
 *
 * The order of `case_id` and `identifier` in the second index
 * matters — the spec writes them in that order because the
 * relation-walk composer's leaf join filters on `case_id` first
 * (the parent-side row) and uses `identifier` to disambiguate
 * (the relation name). The composite leading on `case_id` lets
 * the planner narrow on the parent before checking the relation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("case_indices_ancestor_id_identifier_idx")
		.on("case_indices")
		.columns(["ancestor_id", "identifier"])
		.execute();

	await db.schema
		.createIndex("case_indices_case_id_identifier_idx")
		.on("case_indices")
		.columns(["case_id", "identifier"])
		.execute();
}

/**
 * Drop both static indexes. Symmetric reverse of `up`; Kysely's
 * migrator invokes this only against a database whose
 * `kysely_migration` ledger records this migration as applied.
 *
 * No `.on(table)` qualifier on the drop — Postgres's
 * `DROP INDEX` syntax does NOT accept the `ON table` clause
 * (verified at `https://www.postgresql.org/docs/18/sql-dropindex.html`).
 * Kysely's `DropIndexBuilder.on()` exists for dialects that DO
 * require it (MySQL); applying it here generates `DROP INDEX
 * "name" ON "table"` which Postgres rejects with `syntax error
 * at or near "on"`.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("case_indices_case_id_identifier_idx").execute();
	await db.schema
		.dropIndex("case_indices_ancestor_id_identifier_idx")
		.execute();
}
