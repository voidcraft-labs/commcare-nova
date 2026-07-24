// lib/case-store/sql/database.ts
//
// The Kysely `Database` type. The DDL the types mirror lives in the
// forward-only migration modules at `lib/case-store/migrations/`
// (applied by Kysely's `Migrator` — see `lib/case-store/migrate.ts`).
// Any schema change adds a migration module and updates this file in
// lockstep; the compile-only `database.test.ts` and the harness smoke
// tests catch drift between them.
//
// ## Multi-tenancy — two orthogonal axes
//
// Tenant isolation is the column pair `(app_id, project_id)` — case
// data is shared at Project scope, so every member of a Project sees
// its rows. That is the ONLY structural filter today.
//
// `owner_id` is the SECOND axis: the CommCare case-owner, Nova's
// reserved axis for future location-/group-based access carving. It is
// a first-class column (defaulted to the creating user), NOT a tenant
// boundary and NOT disposable — nothing filters on it yet because
// locations are unimplemented, but when they land, location-based
// access control filters on it BENEATH the Project tenant filter.
//
// No row-level security, no per-tenant schema, no per-tenant database.
// The application funnels reads/writes through a `CaseStore` bound to
// the request's Project id (`withProjectContext`); schema-change row work is
// app-scoped, while `withSchemaContext` dynamically locks the app and observes
// its current Project for every write transaction.
//
// ## JSONB column types do NOT narrow per case type
//
// `properties` is `JSONColumnType<JsonObject>` — the open
// `Record<string, JsonValue>` shape Postgres returns. The
// per-case-type validator lives in `case_type_schemas`'s JSON
// Schema document; narrowing the column type here would fight
// every multi-case-type query. The three-state distinction
// ("absent" / "null" / "empty string") lives at runtime and is
// preserved by the operators the compilers emit (`properties ?
// 'key'`, `properties->>'key' IS NULL`, `= ''`).

import type { ColumnType, JSONColumnType } from "kysely";
import type { LookupRowsTable } from "@/lib/db/pg";

// Standard recursive JSON-value union. Read-side shape of every
// JSONB column; the dialect's serializer turns this tree into a
// string for INSERT/UPDATE.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Live-case row. The runtime read/write surface for every case
 * regardless of case type. JSONB `properties` carries the per-
 * case-type shape; the dozen reserved scalar columns are the
 * fields every case carries.
 */
export interface CasesTable {
	/**
	 * Stable case identifier — opaque TEXT, the CommCare wire
	 * identity. Nova-generated ids default to `uuidv7()::text`
	 * (v7's millisecond-timestamp prefix still clusters INSERT
	 * order tightly on the B-tree primary-key page); callers may
	 * supply any explicit value verbatim — authored
	 * `nova-case-v1:…` ids and CCHQ-style ids included. The id
	 * carries NO time-order claim; `(opened_on, case_id)` is the
	 * durable default ordering.
	 *
	 * `string | undefined` on insert tells Kysely the column is
	 * OPTIONAL — without that branch every insert site would have
	 * to construct a `case_id`, defeating the database default and
	 * the `RETURNING case_id` pattern.
	 */
	case_id: ColumnType<string, string | undefined, string>;

	/** First half of `(app_id, project_id)`. TEXT (not UUID) — an `apps.id` is text (a UUID for new apps; a compact id for pre-cutover apps). */
	app_id: string;

	/** Matches the blueprint's `CaseType.id`. */
	case_type: string;

	/**
	 * Second half of `(app_id, project_id)` — the structural tenant
	 * filter; case data is shared at Project scope. Required on insert
	 * (`withProjectContext` binds it) and non-null on read. (The DB
	 * column is nullable; the `add_cases_project_id` migration module
	 * owns the expand→backfill rollout that keeps the non-null read
	 * contract safe.)
	 */
	project_id: string;

	/**
	 * The CommCare case-owner — Nova's reserved axis for future
	 * location-/group-based access carving, NOT the tenant boundary
	 * (that is `project_id`). Defaults to the creating user; nothing
	 * filters on it today (locations unimplemented), but it is a
	 * first-class field reserved for that access-control axis, never to
	 * be repurposed or dropped. Nullable — HQ-imported cases
	 * pre-assignment carry null. Stays a queryable reserved scalar
	 * column (`RESERVED_SCALAR_COLUMN_BY_PROPERTY`).
	 */
	owner_id: string | null;

	/**
	 * CommCare's built-in open/closed lifecycle status (`@status` on the
	 * wire). Distinct from `closed_on` because both values are part of the
	 * case model; `CaseStore.close()` writes `closed` and the closure timestamp
	 * together. Nullable/wide at the database boundary so historical imports
	 * and pre-invariant rows remain readable for explicit convergence.
	 */
	status: string | null;

	/** Domain timestamp ("when the case was opened"), distinct from row-versioning. The case-list "Date Opened" column reads this. */
	opened_on: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;

	/** Updated on every form-submission write. */
	modified_on: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;

	/** Null while open. Standard "list open cases" query is `WHERE closed_on IS NULL`. */
	closed_on: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;

	/**
	 * Display name. Top-level column (not a JSONB key) because
	 * `case_name` is platform-required on every case regardless of
	 * case-type. Non-empty by DB CHECK; `caseTypeToJsonSchema`
	 * excludes `case_name` from its property output so the column
	 * is the single source of truth.
	 *
	 * **`is-null` / `is-blank` against this column are structurally
	 * always false.** The column is `NOT NULL` with `length > 0`,
	 * so the predicate compiler's emitted SQL is trivially false.
	 * The type checker doesn't reject these AST shapes today
	 * (admits any `RESERVED_SCALAR_COLUMN_BY_PROPERTY` entry on the left
	 * operand without a nullability check), so the SQL compiler
	 * emits the trivially-false predicate rather than throwing.
	 */
	case_name: string;

	/**
	 * CommCare's standard `external_id` case metadata — a cross-system
	 * traceability slot beside `case_name` / `status`, never a JSONB
	 * key. Nova's sample generator fills it with a deterministic,
	 * readable identifier; imports and other create flows may supply
	 * their own. The column also ensures standard-name reads
	 * (`RESERVED_SCALAR_COLUMN_BY_PROPERTY`'s `external_id` /
	 * `external-id` entries) resolve to an honest column instead of
	 * throwing.
	 */
	external_id: string | null;

	/** Denormalized first parent for the common single-parent case. Full ancestor walks go through `case_indices`. */
	parent_case_id: string | null;

	/** Validated against `case_type_schemas[app_id, case_type]` via AJV at every API-route write. */
	properties: JSONColumnType<JsonObject>;
}

/**
 * Per-(app, case-type) JSON Schema row generated from the
 * blueprint's case-type properties. AJV reads it on every case-
 * store write; `applySchemaChange` UPSERTs it whenever the
 * blueprint commits a case-type change.
 */
export interface CaseTypeSchemasTable {
	app_id: string;
	case_type: string;
	/**
	 * JSON Schema document generated by
	 * `lib/domain/predicate/jsonSchema.ts` from the blueprint's
	 * `CaseType.properties[]`. The shape stays open
	 * `Record<string, JsonValue>` — pinning to a specific
	 * Schema-Draft TypeScript type would couple this surface to a
	 * particular validator library.
	 */
	schema: JSONColumnType<JsonObject>;
	/**
	 * The `mutation_seq` this schema row was last synced from — the
	 * monotone guard that makes concurrent additive case-type edits
	 * converge. `applySchemaChange` UPSERTs with the incoming seq guarded
	 * by `WHERE excluded.synced_seq >= case_type_schemas.synced_seq`, so a
	 * stale lower-seq sync no-ops and a peer's concurrently-added property
	 * is never clobbered by an in-flight older write.
	 *
	 * `ColumnType<string, number | undefined, number>`: node-postgres returns
	 * `bigint`/`int8` as a STRING, so the SELECT type is `string` and a reader
	 * coerces `Number(row.synced_seq)` — the type forces the coercion rather
	 * than letting a bare `>=`/`+ 1` silently do string math. Insert is OPTIONAL
	 * (defaults to 0 via the column DEFAULT); update supplies the seq.
	 */
	synced_seq: ColumnType<string, number | undefined, number>;
}

/**
 * `child` is the standard parent-child relation; `extension` is
 * the host-extension relation where closing the host closes the
 * extension. The wire grammars (CSQL, on-device XPath) match
 * across both via `ancestor-exists` / `subcase-exists`; the
 * explicit column lets the Postgres compiler answer
 * direction-specific queries the wire grammars cannot.
 */
export type CaseIndexRelationship = "child" | "extension";

/**
 * Edge table for case-to-case relations (parent-child, host-
 * extension). One row per direct edge; `compileRelationPath`
 * chains direct edges per AST step at `depth = 1`.
 */
export interface CaseIndicesTable {
	case_id: string;
	ancestor_id: string;
	/** `parent`, `host`, or any custom identifier the blueprint defines. */
	identifier: string;
	relationship: CaseIndexRelationship;
	/**
	 * `depth=1` is direct; higher values are reserved for
	 * transitive edges. `compileRelationPath` chains direct edges
	 * per AST step and pins every lookup to `depth = 1`, so the
	 * SQL ignores any transitive rows that happen to be present —
	 * the read strategy stays materialization-agnostic.
	 */
	depth: number;
}

/**
 * Per-property park — where a value lands when a per-row migration
 * (the write-time retype detection, the explicit `retype` /
 * `narrow-options` arms, a rename's discarded destination value)
 * cannot carry it into the property's new declaration. The CASE ROW
 * STAYS in `cases` — only the value moves here, and the row's key
 * drops so merged-document validation keeps admitting the row.
 * These entries are first-class user data awaiting the review /
 * restore surface, never a debug sink.
 *
 * `case_id` carries `ON DELETE CASCADE` off `cases`: entries die
 * with their row (sample-data replace, case deletion), and
 * re-tenanting needs no companion because the park carries no
 * `project_id` — reads reach tenancy by joining through `cases`.
 */
export interface ParkedCaseValuesTable {
	/** Defaulted server-side via `uuidv7()`; application code omits on INSERT. */
	id: ColumnType<string, string | undefined, never>;
	app_id: string;
	case_id: string;
	case_type: string;
	property: string;
	/**
	 * The original value verbatim (NOT normalized to the new schema).
	 * Scalar-or-array jsonb, so the manual `ColumnType` shape rather
	 * than `JSONColumnType` (which requires an object payload);
	 * writers stringify on INSERT exactly as the JSONB columns do.
	 */
	original_value: ColumnType<JsonValue, string, string>;
	/** Person-readable — the same text the report's `failureReasons` carries. */
	reason: string;
	/**
	 * The transition captured at park time — the data-type tokens the
	 * failed cast ran between. A `narrow-options` park carries its
	 * select type on both sides (the "conversion" was an option
	 * removal, not a type change).
	 */
	from_type: string;
	to_type: string;
	/**
	 * The soft archive: a reviewed entry the user chose not to restore.
	 * NULL = active (counted by the discovery badge; candidate for the
	 * winning-sync auto-restore). A dismissed entry stays findable and
	 * explicitly restorable on the review surface.
	 */
	dismissed_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	/** Defaulted server-side via `now()`; application code omits on INSERT. */
	created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Complete Kysely Database type. The runtime instance is constructed
 * elsewhere. `lookup_rows` is `lib/lookup`'s Project-scoped row
 * storage, present here READ-ONLY for `compileTableLookup`'s
 * first-match subqueries — the authoritative shape and every writer
 * live in `lib/db` (the type import keeps the two universes'
 * intersection on the shared pool compatible); the case store never
 * writes these rows.
 */
export interface Database {
	cases: CasesTable;
	case_type_schemas: CaseTypeSchemasTable;
	case_indices: CaseIndicesTable;
	parked_case_values: ParkedCaseValuesTable;
	lookup_rows: LookupRowsTable;
}
