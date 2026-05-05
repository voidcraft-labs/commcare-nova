// lib/case-store/store.ts
//
// The `CaseStore` interface — the single seam every consumer of
// case data binds against. Spec source:
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
// "CaseStore — Cloud SQL Postgres from day-1" section
// (lines 350-389).
//
// ## One interface, one implementation
//
// `PostgresCaseStore` (under `./postgres/store.ts`) is the only
// implementation. Case data is the user's real data; the
// AST→Kysely compiler is the only evaluator. Tests use
// testcontainers Postgres via `setupPerTestDatabase`; production
// uses Cloud SQL via `getCaseStoreDatabase()`. Both paths bind the
// same `Kysely<Database>` shape, so query code written against the
// test fixture runs unchanged against the live instance.
//
// ## Tenant scoping is structural
//
// Every `CaseStore` instance carries an owner id resolved at the
// request boundary. The factory `withOwnerContext(userId)` is the
// single construction path; every method internally adds
// `WHERE owner_id = <bound userId>` to the underlying query so a
// new method on the interface inherits the filter automatically.
// Construction-time enforcement, not caller discipline. The
// underlying compiler stack (`lib/case-store/sql/`) enforces the
// same filter on every JOIN-ed `cases` row inside relation walks
// (see `lib/case-store/sql/compileRelationPath.ts`); the outer
// scan is the implementation's responsibility.
//
// ## What lives here
//
// This module owns the type contracts. The implementation lives in
// `./postgres/store.ts`; the factory lives in `./withOwnerContext.ts`.
// Both depend on this module; this module imports from neither.

import type { Insertable, Selectable, Updateable } from "kysely";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import type { CasesTable, JsonObject } from "./sql/database";

// ---------------------------------------------------------------
// Row shapes derived from the Kysely Database type
// ---------------------------------------------------------------
//
// `Selectable<...>` strips Kysely's `ColumnType<S, I, U>` wrapper
// down to the read-side shape; `Insertable<...>` lowers to the
// insert-side shape (which makes columns with database-generated
// defaults — like `case_id`'s `DEFAULT uuidv7()` — optional);
// `Updateable<...>` to the update-side shape (every column
// optional). Deriving from the table interface keeps the row types
// in lockstep with the schema: a column type narrowing in
// `database.ts` propagates to every consumer here automatically.

/**
 * The shape of a `cases` row as Postgres returns it. Read-side
 * properties (`opened_on` / `modified_on` / `closed_on` are the
 * `Date | null` half of their `ColumnType` triple).
 */
export type CaseRow = Selectable<CasesTable>;

/**
 * The shape an `insert` accepts. `case_id` is optional (omitting
 * it lets Postgres's `DEFAULT uuidv7()` clause fire); the other
 * required columns must be present.
 *
 * `owner_id` is omitted — `PostgresCaseStore` fills it from the
 * bound owner, and callers cannot override it (the implementation
 * always overwrites with the bound owner so cross-tenant inserts
 * are structurally impossible).
 *
 * `app_id` is omitted — the parent `insert(args)` shape supplies
 * `appId` as a top-level field, and `PostgresCaseStore` overwrites
 * `args.row.app_id` with `args.appId` before the write. Admitting
 * `app_id` on the row would be redundant and let a caller supply
 * a value the store discards.
 *
 * `properties` is widened from Kysely's default `JSONColumnType`
 * insert side (string-only) to `JsonObject | string`. Callers who
 * already JSON-stringify their payloads keep the string form; a
 * typed object literal also satisfies the type because the
 * implementation handles either shape (parses + validates + re-
 * stringifies before the write).
 */
export type CaseInsert = Omit<
	Insertable<CasesTable>,
	"app_id" | "owner_id" | "properties"
> & {
	properties: JsonObject | string;
};

/**
 * The shape an `update` accepts. Every column optional. Callers
 * pass the subset of columns they want to change; the
 * implementation merges into the row's current state.
 *
 * Three columns are excluded so the row's identity + tenant pair
 * are immutable through this surface:
 *
 *   - `case_id` — the row's primary key; admitting it would let
 *     a stray patch try to renumber a row, which the implementation
 *     would have to defensively strip.
 *   - `app_id` — moving a row across apps is not a patch shape.
 *     The parent `update(args)` shape carries `appId` as a
 *     top-level field for the WHERE clause; admitting it on the
 *     patch would be ambiguous.
 *   - `owner_id` — re-assigning a case to another tenant is a
 *     separate ownership-transfer flow, not a stray patch field.
 *
 * `properties` is widened to `JsonObject | string | undefined` so
 * either form satisfies the type — same shape as `CaseInsert`.
 */
export type CaseUpdate = Omit<
	Updateable<CasesTable>,
	"app_id" | "case_id" | "owner_id" | "properties"
> & {
	properties?: JsonObject | string;
};

// ---------------------------------------------------------------
// Sort + query argument types
// ---------------------------------------------------------------

/**
 * One sort key for a case-list query. Direction + a typed value
 * expression compiled through the foundation's `compileExpression`.
 *
 * The expression slot is a `ValueExpression` (not a bare property
 * name) so authors can sort by typed reads (`(properties->>'age')::int`)
 * or by computed values (e.g. `today() - opened_on` for a "days
 * since opened" sort).
 */
export interface SortKey {
	/** Sort direction. `asc` = ascending, `desc` = descending. */
	direction: "asc" | "desc";
	/**
	 * The expression to sort by. Compiled via Plan 1's
	 * `compileExpression`; the runtime evaluates the expression once
	 * per row and orders the result set by the values.
	 */
	expression: ValueExpression;
}

/**
 * Arguments for `CaseStore.query`. The predicate compiles through
 * Plan 1's `compilePredicate`; the sort keys compile through
 * `compileExpression`. `limit` and `offset` translate to Postgres
 * `LIMIT` / `OFFSET` clauses when supplied.
 *
 * `appId` is required — every read scopes to one app at a time
 * (cross-app reads aren't a supported authoring pattern).
 * `caseType` is required — the predicate compiler resolves
 * property reads against this case type, and the JSON Schema
 * validator at write time keys rows by `(appId, caseType)`.
 *
 * `blueprint` is required when `predicate` or `sort` is supplied
 * and any operand reads a case property — the compiler stack
 * resolves a `prop` term's `data_type` by walking the blueprint's
 * matching `CaseType`, picking the column cast (e.g.
 * `(properties->>'age')::int` for an `int` property). The same
 * shape `applySchemaChange` consumes: a caller-supplied snapshot
 * of the prospective blueprint state. Predicate-free, sort-free
 * `query` calls (or queries whose operands touch only the four
 * reserved scalar columns `case_id` / `case_type` / `owner_id` /
 * `status`) work without a `blueprint` because no property-read
 * cast is needed.
 */
export interface QueryArgs {
	/** The owning app — first half of the `(app_id, owner_id)` tenant pair. */
	appId: string;
	/** The case type to read from. Constrains the SELECT to rows of this type. */
	caseType: string;
	/**
	 * The current blueprint snapshot. Optional because
	 * predicate-free, sort-free queries do not need one; required
	 * when any operand resolves a `prop` term's `data_type`.
	 */
	blueprint?: BlueprintDoc;
	/**
	 * Optional boolean filter. When absent, the query selects every
	 * row matching the tenant + case-type filter.
	 */
	predicate?: Predicate;
	/** Optional sort keys, applied in order. */
	sort?: SortKey[];
	/** Optional row cap. */
	limit?: number;
	/** Optional row offset (for pagination). */
	offset?: number;
}

// ---------------------------------------------------------------
// applySchemaChange argument + result types
// ---------------------------------------------------------------

/**
 * The three change-shape arms `applySchemaChange` runs per-row
 * migrations for. Spec § "Schema migration policy" (lines 309-340).
 *
 *   - `rename(from, to)` — atomic JSONB key rename. Existing rows'
 *     value at `properties.<from>` moves to `properties.<to>` in
 *     one UPDATE.
 *   - `retype(fromType, toType)` — try to re-cast each existing
 *     value per the spec's policy table; cast failures move to
 *     `cases_quarantine` with the original value preserved.
 *   - `narrow-options(removedOptions)` — rows whose select value
 *     is in `removedOptions` move to `cases_quarantine` (the value
 *     is no longer in the option set; loud failure rather than
 *     silent acceptance).
 */
export type SchemaChangeKind =
	| {
			kind: "rename";
			/** The old property name (key in `properties` JSONB). */
			from: string;
			/** The new property name. */
			to: string;
	  }
	| {
			kind: "retype";
			/** The previous property data type. */
			fromType: CasePropertyDataType;
			/** The new property data type. */
			toType: CasePropertyDataType;
	  }
	| {
			kind: "narrow-options";
			/**
			 * The option values removed from a `single_select` /
			 * `multi_select`. Rows whose stored value is in this list
			 * move to `cases_quarantine`.
			 */
			removedOptions: string[];
	  };

/**
 * Arguments for `CaseStore.applySchemaChange`. The schema sync
 * (always-runs half) reads the current case type from `blueprint`
 * and regenerates the JSON Schema via `caseTypeToJsonSchema`. The
 * per-row migration (only-when-`change`-is-present half) walks
 * matching rows and applies the change shape. Both halves run in
 * one Postgres transaction — the database never holds a new schema
 * with rows that fail validation against it.
 *
 * The `blueprint` parameter (rather than re-fetching from
 * Firestore) makes the call self-contained: the caller passes the
 * prospective state in, commits Firestore on success, and runs a
 * compensating `applySchemaChange(previousState)` on Firestore-
 * commit failure. The shape is the cross-store saga seam — the
 * orchestrator that wires Firestore writes to case-store schema
 * sync owns the saga; this signature pins what each call carries.
 */
export interface ApplySchemaChangeArgs {
	/** The owning app. */
	appId: string;
	/** The case type whose schema is being synced. */
	caseType: string;
	/**
	 * The prospective blueprint state. The function reads the
	 * matching `CaseType` and feeds it through `caseTypeToJsonSchema`
	 * to derive the JSON Schema row.
	 */
	blueprint: BlueprintDoc;
	/**
	 * The property the change targets. Required when `change` is
	 * present; ignored when `change` is absent (the additive-mutation
	 * path runs schema sync only).
	 */
	property?: string;
	/**
	 * The change shape. Absent means "additive blueprint mutation"
	 * (schema sync only); present triggers the matching per-row
	 * migration in the same transaction.
	 */
	change?: SchemaChangeKind;
}

/**
 * Per-row outcome from a `change`-driven migration. `migrated`
 * rows updated in place; `quarantined` rows moved to
 * `cases_quarantine` with `quarantine_reason`; `skipped` rows
 * untouched (for `rename`, rows that didn't have the `from` key;
 * for the others, rows that didn't carry the targeted property).
 *
 * The `failureReasons` array surfaces the exact `quarantine_reason`
 * each quarantined row carries — author-facing review UI reads
 * these directly to explain what went wrong.
 */
export interface MigrationReport {
	/** Number of rows updated in place. */
	migrated: number;
	/** Number of rows moved to `cases_quarantine`. */
	quarantined: number;
	/** Number of rows untouched (didn't carry the targeted property). */
	skipped: number;
	/**
	 * Per-quarantined-row failure reason text. One entry per
	 * `quarantined` row, in row-iteration order. Empty when
	 * `quarantined === 0`.
	 */
	failureReasons: string[];
}

// ---------------------------------------------------------------
// CaseStore interface
// ---------------------------------------------------------------

/**
 * The storage contract every consumer of case data binds against.
 *
 * Construction is via the `withOwnerContext(userId)` factory —
 * there is no other constructor. Every method internally applies
 * the bound owner's filter; `(app_id, owner_id)` tenant scoping
 * is structural, not caller discipline.
 *
 * Method-level behavior:
 *
 *   - `query` — predicate-driven SELECT, sort + limit + offset
 *     applied at the SQL layer.
 *   - `insert` — validates the candidate `properties` payload
 *     against `case_type_schemas[appId, caseType].schema` via
 *     `ajv` before the row hits Postgres. Writes the row, captures
 *     the generated `case_id` via `RETURNING`, derives
 *     `case_indices` direct edges from `parent_case_id` in the
 *     same transaction.
 *   - `update` — JSONB-merges the patch into `properties`,
 *     re-validates against the schema, updates `modified_on`,
 *     re-derives `case_indices` if `parent_case_id` changed.
 *   - `close` — sets `closed_on = now()` (and optionally `status`).
 *     Does not delete the row — closed cases are still visible to
 *     audit / admin views.
 *   - `traverse` — compiles the supplied `RelationPath` via Plan 1's
 *     `compileRelationPath` and returns the leaf rows the walk
 *     reaches.
 *   - `applySchemaChange` — sync: schema regen + UPSERT, plus the
 *     rename / retype / narrow-options per-row migration when a
 *     `change` is present. Both halves run in one Postgres
 *     transaction so the database never holds a new schema with
 *     rows that fail validation against it.
 *   - `generateSampleData` — drives the bound `SampleCaseGenerator`
 *     to build deterministic per-`(app, caseType, seed)` rows and
 *     routes them through `insert` so generated rows participate in
 *     the same JSON Schema validation + `case_indices` derivation
 *     real inserts use.
 *   - `resetSampleData` — deletes every row of the case-type for
 *     the bound tenant + drops their `case_indices` edges, then
 *     regenerates from a fresh seed. Atomic: deletion + regeneration
 *     run inside one Postgres transaction.
 */
export interface CaseStore {
	/**
	 * Run a predicate-driven SELECT against `cases`. Compiles the
	 * predicate + sort keys via Plan 1's compiler stack and executes
	 * against the bound tenant. Returns the matching rows in the
	 * sort order specified (or insertion order when no sort is
	 * supplied — driven by `case_id`'s UUID v7 timestamp prefix).
	 */
	query(args: QueryArgs): Promise<CaseRow[]>;

	/**
	 * Insert a new case row. Validates the candidate `properties`
	 * payload against the case-type's JSON Schema before the row
	 * lands in Postgres; rejects with a descriptive error on schema
	 * mismatch. Returns the generated `case_id` (captured via
	 * `RETURNING`).
	 */
	insert(args: { appId: string; row: CaseInsert }): Promise<{
		caseId: string;
	}>;

	/**
	 * Update a case row. Merges the patch into the row's
	 * `properties` JSONB document, re-validates the merged result
	 * against the schema, updates `modified_on` to `now()`,
	 * re-derives `case_indices` if `parent_case_id` changed. The
	 * patch must NOT include `owner_id`; callers cannot reassign a
	 * case across tenants through this surface.
	 */
	update(args: {
		appId: string;
		caseId: string;
		patch: CaseUpdate;
	}): Promise<void>;

	/**
	 * Close a case row. Sets `closed_on = now()`; optionally
	 * updates `status`. Does not delete — closed cases remain
	 * queryable for audit / admin views.
	 */
	close(args: {
		appId: string;
		caseId: string;
		status?: string;
	}): Promise<void>;

	/**
	 * Traverse a `RelationPath` from a starting case to its
	 * destination(s). Compiles the path via Plan 1's
	 * `compileRelationPath`; returns the leaf cases the walk
	 * reaches. Self-paths return the starting case itself; ancestor
	 * walks return the chain's destination; subcase / any-relation
	 * walks return every matching child / both directions.
	 */
	traverse(args: {
		appId: string;
		caseId: string;
		via: RelationPath;
	}): Promise<CaseRow[]>;

	/**
	 * Sync the case-type's JSON Schema with the prospective
	 * blueprint state, optionally running a per-row migration when
	 * a `change` shape is supplied. Both halves run in one Postgres
	 * transaction — the database never holds a new schema with
	 * rows that fail validation against it.
	 */
	applySchemaChange(args: ApplySchemaChangeArgs): Promise<MigrationReport>;

	/**
	 * Generate `count` sample rows for `caseType` against the
	 * supplied prospective blueprint state and write them through
	 * `insert`. Deterministic per `(app, caseType, seed)` — the same
	 * tuple yields the same row sequence on every call.
	 *
	 * The implementation queries existing parent rows for any
	 * declared parent case-type and threads them as candidate
	 * `parent_case_id` targets so the generator's parent linkage
	 * resolves to real ids; the case-store derives `case_indices`
	 * direct edges from those linkages at insert time.
	 *
	 * Returns the count of rows actually inserted. Each row's write
	 * runs through `insert`, which opens its own transaction for the
	 * row + edge derivation; a mid-loop failure stops the loop and
	 * propagates the error, leaving rows already inserted in place.
	 * Callers that need an all-or-nothing population pair this with
	 * an outer cleanup path.
	 */
	generateSampleData(args: GenerateSampleDataArgs): Promise<{
		inserted: number;
	}>;

	/**
	 * Delete every row of `caseType` for the bound tenant + drop
	 * the matching `case_indices` edges, then regenerate from a
	 * fresh seed.
	 *
	 * The deletion runs in one transaction (cases + edges drop
	 * atomically); the regeneration runs after the deletion commits
	 * because each row's `insert` opens its own per-row transaction
	 * and Postgres rejects a nested BEGIN. A mid-regeneration failure
	 * leaves the case-type partially populated; callers that need
	 * stricter consistency pair this with an outer retry path.
	 *
	 * Returns the count of rows deleted and inserted; either count
	 * may be zero on a fresh empty case type or a degenerate-count
	 * regenerate.
	 */
	resetSampleData(args: ResetSampleDataArgs): Promise<{
		deleted: number;
		inserted: number;
	}>;
}

// ---------------------------------------------------------------
// Sample-data argument types
// ---------------------------------------------------------------

/**
 * Arguments for `CaseStore.generateSampleData`. The `blueprint`
 * field threads the prospective blueprint state in the same way
 * `applySchemaChange` does — the generator reads `data_type`,
 * options, property names off the matching `CaseType`, and the
 * parent-id resolution path reads the case-type relationship graph
 * from the same blueprint.
 *
 * `count` and `seed` are passed straight through to the bound
 * `SampleCaseGenerator`.
 */
export interface GenerateSampleDataArgs {
	/** The owning app — written through into every row's `app_id`. */
	appId: string;
	/** The case-type to populate. */
	caseType: string;
	/** The number of rows to generate. */
	count: number;
	/**
	 * The PRNG seed. Same `(appId, caseType, seed)` tuple yields
	 * the same row sequence on every call.
	 */
	seed: string;
	/** The prospective blueprint state. Source for case-type definitions. */
	blueprint: BlueprintDoc;
}

/**
 * Arguments for `CaseStore.resetSampleData`. The implementation
 * picks a fresh seed (driven by `Date.now()` or equivalent) for
 * the regeneration step — callers reset specifically to randomize
 * the population, so the seed is implementation-owned. Tests can
 * call `generateSampleData` directly when they need a fixed seed.
 */
export interface ResetSampleDataArgs {
	/** The owning app. */
	appId: string;
	/** The case-type to reset. */
	caseType: string;
	/** The number of rows to regenerate. */
	count: number;
	/** The prospective blueprint state. Source for case-type definitions. */
	blueprint: BlueprintDoc;
}

// ---------------------------------------------------------------
// Helpers exposed for the implementation
// ---------------------------------------------------------------

/**
 * Locate a case type within a blueprint by name. Used by
 * `applySchemaChange` to derive the JSON Schema from the
 * prospective blueprint state. Throws when the case type is
 * absent — the caller must supply the prospective blueprint with
 * the case type still defined (additive mutations preserve it; a
 * removal is a different lifecycle and not a `change` arm here).
 */
export function findCaseTypeOrThrow(
	blueprint: BlueprintDoc,
	caseType: string,
): CaseType {
	const found = blueprint.caseTypes?.find((c) => c.name === caseType);
	if (!found) {
		throw new Error(
			`applySchemaChange: blueprint does not contain a case type named "${caseType}". ` +
				`The blueprint must include the case type before its schema can be synced; ` +
				`a removal is a different lifecycle than a schema change and is not handled here.`,
		);
	}
	return found;
}

/**
 * Build the `name → CaseType` map every Plan 1 compiler reads
 * from `TermCompileContext.caseTypeSchemas`. The map is populated
 * from the blueprint's `caseTypes` array; a `null` `caseTypes`
 * yields an empty map. The map is `ReadonlyMap` because the
 * compiler stack is read-only against it — it never mutates the
 * lookup surface.
 *
 * Used by `query` to resolve property data types when the
 * predicate / sort touches case properties; relation-walk
 * destinations resolve through the same map.
 */
export function buildCaseTypeMap(
	blueprint: BlueprintDoc | undefined,
): ReadonlyMap<string, CaseType> {
	if (blueprint === undefined) {
		return new Map();
	}
	const map = new Map<string, CaseType>();
	for (const caseType of blueprint.caseTypes ?? []) {
		map.set(caseType.name, caseType);
	}
	return map;
}
