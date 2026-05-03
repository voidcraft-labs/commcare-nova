// lib/case-store/sql/database.ts
//
// The Kysely `Database` type for Nova's case store.
//
// Three tables make up the case store:
//
//   - `cases` — one row per case, across all apps and tenants. The
//     live runtime table that every case-list query reads from and
//     every form submission writes to.
//   - `case_type_schemas` — JSON Schema documents per
//     `(app_id, case_type)`. Derived from the blueprint's
//     `CaseType.properties[].data_type` and consumed by the
//     case-store's TypeScript validator (`ajv` against the schema
//     row) at every API-route write. There is no in-database
//     trigger; the API route is the trust boundary.
//   - `case_indices` — case-relation edges. One row per direct
//     ancestor edge (depth=1). Multi-hop traversals compose as a
//     chain of `(case_indices, cases)` joins, one per AST step;
//     see `lib/case-store/sql/compileRelationPath.ts`. The
//     architectural answer to CCHQ's `MAX_RELATED_CASES = 500_000`
//     per-hop scan: a single indexed lookup on
//     `(case_id, identifier)` resolves each hop, and the chain
//     stays statically known from the AST so no recursion is
//     needed.
//
// The DDL the types mirror is the single source of truth at
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`
// lines 249-284. Any change to the SQL schema must update both
// surfaces in lockstep.
//
// ## Multi-tenancy model
//
// Tenant isolation on the `cases` table is the column pair
// `(app_id, owner_id)`. There is no row-level security policy,
// no per-tenant schema, no per-tenant database. The application
// layer is expected to funnel all access through a `CaseStore`
// interface that always supplies the owner-id filter from the
// request boundary. (Spec § "CaseStore", line 389.)
//
// ## Postgres-strict null semantics
//
// The `properties` column is JSONB. The case store distinguishes
// three states for any property:
//
//   - "key absent in JSONB document"
//   - "key present with JSON null"
//   - "key present with empty string (or other empty-by-type value)"
//
// The TypeScript column type does not — and cannot — narrow these
// three states into separate static types. JSONB is structurally
// `Record<string, JsonValue>`, where `JsonValue` is the standard
// recursive JSON union including `null`. The three-state
// distinction lives in the JSONB document at runtime and is
// preserved by the Postgres operators the case-list compilers
// emit:
//
//   - `properties ? 'key'`         — key-existence check
//   - `properties->>'key' IS NULL` — null OR absent
//   - `properties->>'key' = ''`    — empty string (collapses with
//                                    absent in CCHQ wire form, but
//                                    Postgres distinguishes them)
//
// Anyone tempted to over-narrow this column to a per-case-type
// shape: don't. The JSON Schema in `case_type_schemas` is the
// per-case-type validator; the column type is the open
// JSONB document the validator runs against. Narrowing here would
// fight every multi-case-type query.
//
// ## Why the Database interface owns no migration logic
//
// This module is a single-responsibility type module. Schema
// migrations, sample-data seeding, and the case-store query
// surface live in sibling modules under `lib/case-store/`. The
// only export here is the type contract; the runtime behavior
// composes on top.

import type { ColumnType, JSONColumnType } from "kysely";

// ---------------------------------------------------------------
// JSON value tree
// ---------------------------------------------------------------
//
// The standard recursive JSON-value union. Used as the deserialized
// shape of every JSONB column on the read side. JSONB on the wire
// is a JSON document; the dialect's serializer turns this tree into
// a string for INSERT/UPDATE.

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------
// `cases` table — DDL spec lines 254-265
// ---------------------------------------------------------------

export interface CasesTable {
	/**
	 * Stable case identifier. UUID generated at case creation by
	 * the application layer (Postgres does not generate these —
	 * the application controls the value to keep cross-system
	 * traceability with CCHQ-style case IDs).
	 *
	 * Spec line 255: `case_id UUID PRIMARY KEY`.
	 */
	case_id: string;

	/**
	 * Owning app identifier. Half of the `(app_id, owner_id)`
	 * tenant-isolation pair. TEXT, not UUID — apps are root-level
	 * Firestore documents whose IDs are application-controlled
	 * strings, and the case store mirrors that shape.
	 *
	 * Spec line 256: `app_id TEXT NOT NULL`.
	 */
	app_id: string;

	/**
	 * The case-type name. Matches the blueprint's `CaseType.id`
	 * for the case type this case belongs to.
	 *
	 * Spec line 257: `case_type TEXT NOT NULL`.
	 */
	case_type: string;

	/**
	 * The Better Auth user ID of the case owner. Half of the
	 * `(app_id, owner_id)` tenant-isolation pair. Nullable —
	 * cases can exist without an explicit owner during
	 * intermediate states (HQ-imported cases pre-assignment,
	 * sample-data fixtures keyed only by app).
	 *
	 * Spec line 258: `owner_id TEXT` (no NOT NULL).
	 */
	owner_id: string | null;

	/**
	 * Open / closed status string. Distinct from `closed_on` so
	 * that domain-specific status vocabularies (e.g. CommCare's
	 * `open` / `closed` tokens) round-trip without lossy
	 * derivation from a timestamp. Nullable.
	 *
	 * Spec line 259: `status TEXT`.
	 */
	status: string | null;

	/**
	 * Domain timestamp: when the case was opened. Distinct from
	 * any database-housekeeping timestamp; `opened_on` is the
	 * value the case-list `Date Opened` column reads.
	 *
	 * Spec line 260: `opened_on TIMESTAMPTZ` (nullable).
	 */
	opened_on: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;

	/**
	 * Domain timestamp: most recent modification. Updated on
	 * every form-submission write through the case store.
	 *
	 * Spec line 261: `modified_on TIMESTAMPTZ` (nullable).
	 */
	modified_on: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;

	/**
	 * Domain timestamp: when the case was closed. Null while
	 * open. The standard "list open cases" query is
	 * `WHERE closed_on IS NULL`.
	 *
	 * Spec line 262: `closed_on TIMESTAMPTZ` (nullable).
	 */
	closed_on: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;

	/**
	 * Denormalized first-parent identifier. Convenience column
	 * for the common single-parent case — full ancestor walks go
	 * through `case_indices`. Nullable for orphan cases.
	 *
	 * Spec line 263: `parent_case_id UUID` (nullable, denormalized
	 * first parent).
	 */
	parent_case_id: string | null;

	/**
	 * The case-property document. Validated against the
	 * `case_type_schemas[app_id, case_type]` JSON Schema by the
	 * case-store's TypeScript validator (`ajv`) at every API-route
	 * write to `cases`. The API route is the trust boundary; the
	 * database is internal and carries no validation trigger. The
	 * Term compiler reads values via `properties->>'key'` with a
	 * per-property cast keyed on the JSON Schema's declared
	 * `data_type`.
	 *
	 * The TypeScript shape is open `JsonObject` — see the
	 * "Postgres-strict null semantics" header for why per-case-type
	 * narrowing belongs in the JSON Schema, not in this column type.
	 *
	 * Spec line 264: `properties JSONB NOT NULL`.
	 */
	properties: JSONColumnType<JsonObject>;
}

// ---------------------------------------------------------------
// `case_type_schemas` table — DDL spec lines 267-272
// ---------------------------------------------------------------

export interface CaseTypeSchemasTable {
	/**
	 * Owning app identifier. First half of the composite primary
	 * key.
	 *
	 * Spec line 268: `app_id TEXT NOT NULL`.
	 */
	app_id: string;

	/**
	 * The case-type name. Second half of the composite primary
	 * key — together `(app_id, case_type)` is unique.
	 *
	 * Spec line 269: `case_type TEXT NOT NULL`.
	 */
	case_type: string;

	/**
	 * The JSON Schema document describing the property surface
	 * for this case type. Generated by
	 * `lib/domain/predicate/jsonSchema.ts` from the blueprint's
	 * `CaseType.properties[]`. The case-store's TypeScript
	 * validator (`ajv` against this row) runs at every
	 * API-route write to `cases`; the database is internal and
	 * carries no validation trigger.
	 *
	 * The shape is the JSON Schema spec's open
	 * `Record<string, JsonValue>` — pinning it to a specific
	 * Schema-Draft TypeScript type would couple this surface to
	 * a particular validator library. The Database interface
	 * stays library-agnostic; the validator owns its own input
	 * type.
	 *
	 * Spec line 270: `schema JSONB NOT NULL` (a JSON Schema
	 * document).
	 */
	schema: JSONColumnType<JsonObject>;
}

// ---------------------------------------------------------------
// `case_indices` table — DDL spec lines 274-283
// ---------------------------------------------------------------

/**
 * The two CCHQ relation kinds. `child` is the standard
 * parent-child relation; `extension` is the host-extension
 * relation where closing the host closes the extension.
 *
 * Both wire grammars (CSQL, on-device XPath) match identifiers
 * across both relationship types via `ancestor-exists` /
 * `subcase-exists`; the explicit relationship column lets the
 * Postgres compiler answer direction-specific queries the wire
 * grammars cannot.
 *
 * Spec line 278: `relationship TEXT NOT NULL` with explicit
 * comment `'child' | 'extension'`.
 */
export type CaseIndexRelationship = "child" | "extension";

export interface CaseIndicesTable {
	/**
	 * The descendant case in the relation edge. Foreign key to
	 * `cases.case_id`.
	 *
	 * Spec line 275: `case_id UUID NOT NULL`.
	 */
	case_id: string;

	/**
	 * The ancestor case in the relation edge. Foreign key to
	 * `cases.case_id`.
	 *
	 * Spec line 276: `ancestor_id UUID NOT NULL`.
	 */
	ancestor_id: string;

	/**
	 * The relation name. `parent`, `host`, or any custom
	 * identifier the blueprint defines. Open string —
	 * applications coin custom relation names freely.
	 *
	 * Spec line 277: `identifier TEXT NOT NULL` with comment
	 * `'parent', 'host', custom`.
	 */
	identifier: string;

	/**
	 * The kind of relation edge — see `CaseIndexRelationship`.
	 *
	 * Spec line 278: `relationship TEXT NOT NULL` with comment
	 * `'child' | 'extension'`.
	 */
	relationship: CaseIndexRelationship;

	/**
	 * Edge depth. `depth=1` means a direct edge between a case
	 * and its immediate ancestor. Higher values are reserved for
	 * storing transitive edges. The relation-path compiler
	 * (`lib/case-store/sql/compileRelationPath.ts`) chains direct
	 * edges per AST step and pins every `case_indices` lookup to
	 * `depth = 1`, so the SQL ignores any transitive rows that
	 * happen to be present and the read strategy stays
	 * materialization-agnostic.
	 *
	 * Spec line 279: `depth INT NOT NULL` with comment
	 * `1 = direct, 2 = grandparent`.
	 */
	depth: number;
}

// ---------------------------------------------------------------
// Database interface
// ---------------------------------------------------------------

/**
 * The complete Kysely Database type for the case store.
 *
 * Every typed query the case-list / search / sample-data
 * compilers emit binds against this interface. The interface is
 * the compile-time contract that catches column-name typos,
 * type-mismatch comparisons, and JSONB-shape drift before runtime.
 *
 * The runtime instance of `Kysely<Database>` is created elsewhere
 * — this module owns the type, not the connection.
 */
export interface Database {
	cases: CasesTable;
	case_type_schemas: CaseTypeSchemasTable;
	case_indices: CaseIndicesTable;
}
