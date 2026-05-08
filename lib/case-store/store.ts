// lib/case-store/store.ts
//
// The `CaseStore` interface and its row / arg / result types — the
// type contracts the implementation (`./postgres/store.ts`) and the
// factory (`./withOwnerContext.ts`) both depend on. This module
// imports from neither. Spec source:
// `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
// "CaseStore — Cloud SQL Postgres from day-1" (lines 350-389). See
// `lib/case-store/CLAUDE.md` for the architectural contract
// (one interface / one implementation, structural tenant scoping).
//
// Methods take their narrow dependency directly: predicate / sort /
// calculated-column compilation needs the case-type schema map; the
// sample-data path needs one `CaseType` definition. Callers convert
// `BlueprintDoc → ReadonlyMap<string, CaseType>` at the boundary via
// `buildCaseTypeMap` so the interface stays decoupled from the full
// blueprint shape.

import type { Insertable, Selectable } from "kysely";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	CaseType,
	Column,
} from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import type { CasesTable, JsonObject, JsonValue } from "./sql/database";

/**
 * Calculated-column projection arm — the `kind: "calculated"` slice of
 * the authoring `Column` discriminated union. The case-store's
 * `query` accepts arrays of this arm directly so callers pass the
 * same column entries the editor authors without an intermediate
 * shape conversion. The `uuid` is the SELECT alias key
 * (`__nova_calc__<uuid>`); the `expression` is the per-row
 * `ValueExpression` the SQL emitter compiles into a projection.
 */
export type CalculatedColumn = Extract<Column, { kind: "calculated" }>;

// Row shapes derived from the Kysely Database type. `Selectable`
// strips `ColumnType<S, I, U>` to the read shape; `Insertable`
// drops database-generated columns (e.g. `case_id`'s `DEFAULT
// uuidv7()`). Deriving from the table interface keeps these row
// types in lockstep with the schema.

/** The shape of a `cases` row as Postgres returns it. */
export type CaseRow = Selectable<CasesTable>;

/**
 * The shape an `insert` accepts. `case_id` is optional (omitting
 * it lets Postgres's `DEFAULT uuidv7()` fire). `owner_id` and
 * `app_id` are omitted — `PostgresCaseStore` fills them from the
 * bound owner and the top-level `appId` argument, and callers
 * cannot override.
 *
 * `properties` widens to `JsonObject | string`. The implementation
 * parses + validates + re-stringifies either shape before the write
 * so callers may pass a typed object literal or a pre-stringified
 * payload uniformly.
 */
export type CaseInsert = Omit<
	Insertable<CasesTable>,
	"app_id" | "owner_id" | "properties"
> & {
	properties: JsonObject | string;
};

/**
 * Patch shape for `CaseStore.update`. Deny-by-default — authored as
 * an explicit allowlist rather than derived via `Omit` so a future
 * column addition to `CasesTable` does NOT silently widen the patch
 * surface. Identity columns (`case_id` / `app_id` / `owner_id` /
 * `case_type`) and the auto-stamped `modified_on` are excluded by
 * design; retyping a row is the `applySchemaChange` flow, not a
 * freestanding patch.
 */
export interface CaseUpdate {
	/** The case's display name. Routed to the top-level `case_name` column, NOT the JSONB document. */
	readonly case_name?: string;
	/** Open/closed status string. `null` admits the rare admin / data-recovery flow. */
	readonly status?: string | null;
	/** When the case was opened — patchable for historical-import flows. */
	readonly opened_on?: Date | string | null;
	/** When the case was closed. Setting `null` is the "reopen" path; the dedicated `close()` method stamps this column to `now()` for forward closure. */
	readonly closed_on?: Date | string | null;
	/** Denormalized first-parent identifier. Patching triggers `case_indices` re-derivation in the same transaction. `null` clears the parent edge. */
	readonly parent_case_id?: string | null;
	/** The user-defined case-property document. The implementation JSONB-merges the patch into the existing document and re-validates against the case-type's JSON Schema. */
	readonly properties?: JsonObject | string;
}

/**
 * One sort key for a case-list query. The expression slot is a
 * `ValueExpression` (not a bare property name) so authors can sort
 * by typed reads (`(properties->>'age')::int`) or computed values
 * (e.g. `today() - opened_on` for a "days since opened" sort).
 */
export interface SortKey {
	direction: "asc" | "desc";
	expression: ValueExpression;
}

/**
 * Arguments for `CaseStore.query`. Single-shaped result regardless
 * of whether `calculated` is supplied — the `calculated: {}` map per
 * row reads uniformly across consumers.
 *
 * `caseTypeSchemas` is required when `predicate`, `sort`, or
 * `calculated` references a case property — the term compiler
 * resolves each `prop` term's `data_type` from the case-type schema
 * map to pick the column cast. Optional when the query is
 * predicate-free, sort-free, and calc-free, OR when every operand
 * touches only the reserved scalar columns at
 * `lib/case-store/sql/dataTypeTokens.ts`'s `RESERVED_SCALAR_COLUMNS`.
 *
 * `calculated` projections evaluate inline at the SQL layer keyed
 * by the column's `uuid`; `lib/case-store/CLAUDE.md` § "Sample-data"
 * documents the single-evaluator stance the project locks in.
 *
 * Empty / absent `calculated` produces an empty `calculated: {}`
 * map per row. Postgres has no per-row value-budget on SELECT
 * projections, but consumers should keep the count proportional to
 * the case list's authored shape.
 */
export interface QueryArgs {
	appId: string;
	caseType: string;
	caseTypeSchemas?: ReadonlyMap<string, CaseType>;
	predicate?: Predicate;
	sort?: SortKey[];
	calculated?: ReadonlyArray<CalculatedColumn>;
	limit?: number;
	offset?: number;
}

/**
 * Arguments for `CaseStore.count`. Subset of `QueryArgs` — `count`
 * never sorts, never paginates, and never projects calculated
 * columns; it returns a single integer for the row population the
 * `(appId, caseType, predicate?)` triple resolves to.
 *
 * `caseTypeSchemas` is required when `predicate` reads a case
 * property (same data-type-resolution contract as `QueryArgs`).
 * Predicate-free callers pass `predicate: undefined`; the
 * implementation skips the WHERE clause entirely so the count
 * collapses to a sequential / index scan over the case-type
 * partition.
 */
export interface CountArgs {
	appId: string;
	caseType: string;
	caseTypeSchemas?: ReadonlyMap<string, CaseType>;
	predicate?: Predicate;
}

/**
 * Wire-shape of a single calculated-column value as pg-driver hands
 * it back. `JsonValue` covers `null` / string / number / boolean /
 * arrays / nested objects; `Date` covers Postgres's `date` /
 * `timestamptz` deserialization (per-OID typed deserializers, NOT
 * ISO strings).
 *
 * Numerics are returned as strings by pg's arbitrary-precision
 * decimal deserializer; integers come back as numbers. Both fit
 * inside `JsonValue`. The Date arm is the only widening this union
 * adds beyond `JsonValue` — the cell renderer in
 * `DisplayPreview.tsx` discriminates on `instanceof Date` to format
 * temporal values without `JSON.stringify`'s quoted-ISO output.
 *
 * Pinned by the contract test
 * `lib/case-store/__tests__/storeContract.ts → "returns a Date
 * object for a date-typed calculated expression"`; a regression
 * would surface there.
 */
export type CalculatedValue = JsonValue | Date;

/**
 * Result row shape for `query`. Folds the calculated map ONTO the
 * row rather than returning a sidecar array — sidecar arrays couple
 * by index, and any future filter / sort transform applied to one
 * half would silently misalign the two. One row, one calculated
 * map, never desyncs.
 *
 * The `calculated` map is keyed by the calculated column's `uuid`
 * (the column-level identity slot every `Column` arm carries); a
 * calculated column whose expression evaluates to SQL NULL emits
 * `uuid → null` (NOT omitted from the map). Consumers can
 * therefore distinguish "column absent from the query" (key not
 * in map) from "column evaluated to null" (`map[uuid] === null`).
 *
 * When `QueryArgs.calculated` is empty / absent, every row carries
 * an empty `calculated: {}` map.
 *
 * Two collision classes the projection handles:
 *
 *   1. **Calculated uuid vs `cases` column collision.** A
 *      programmatic caller could supply a uuid string that matches
 *      a reserved column name (`case_name`, `case_id`, `case_type`,
 *      `owner_id`, `status`, `app_id`, `opened_on`, `closed_on`,
 *      `modified_on`, `parent_case_id`, `properties`). Without
 *      protection, Postgres allows duplicate output names; pg-
 *      driver's row deserializer keeps the LAST occurrence (the
 *      calculated expression's value); the row's actual scalar
 *      value is silently corrupted.
 *      `PostgresCaseStore.query` defends structurally by emitting
 *      calculated aliases under a fixed `__nova_calc__<uuid>`
 *      prefix in the SELECT, then unprefixing during the row
 *      partition — the wire and the consumer-facing key live in
 *      disjoint keyspaces, so this collision class is impossible
 *      regardless of the supplied uuid.
 *
 *   2. **Duplicate uuid across siblings.** When two `calculated`
 *      entries share the same `uuid`, the SELECT emits two columns
 *      under the same `__nova_calc__<uuid>` alias; pg-driver keeps
 *      the last and the second occurrence's value overwrites the
 *      first's. Column uuids are generated fresh per add and
 *      preserved across edits, so the authoring layer never
 *      produces siblings with a duplicate uuid; the SQL layer
 *      trusts that upstream invariant for this class.
 *
 *   3. **Alias overflow past Postgres' 63-byte identifier cap.**
 *      Postgres silently truncates identifiers at
 *      `NAMEDATALEN - 1` (63 bytes). The composed alias
 *      `__nova_calc__<uuid>` (13 bytes of prefix) gets truncated
 *      when `uuid` pushes the total over the cap; the row-
 *      partition step uses the FULL pre-truncation alias to read
 *      each calculated value, misses the truncated wire-side key,
 *      and silently emits `null` for every row. Two uuids
 *      matching in the truncation prefix would collide on the
 *      same wire alias. `query` defends with a pre-projection
 *      byte-length check that throws a `compilerBugMessage`
 *      naming the over-cap alias — same shape as the `indexName`
 *      defense under `applySchemaChange`.
 */
export type CaseRowWithCalculated = CaseRow & {
	readonly calculated: Readonly<Record<string, CalculatedValue>>;
};

/**
 * The three change-shape arms `applySchemaChange` runs per-row
 * migrations for. Spec § "Schema migration policy" (lines 309-340).
 *
 *   - `rename(from, to)` — JSONB key rename in one UPDATE.
 *   - `retype(fromType, toType)` — per-row cast attempt; cast
 *     failures move to `cases_quarantine` with the original value
 *     preserved.
 *   - `narrow-options(removedOptions)` — rows whose select value
 *     is in `removedOptions` move to `cases_quarantine` (loud
 *     failure rather than silent acceptance).
 */
export type SchemaChangeKind =
	| { kind: "rename"; from: string; to: string }
	| {
			kind: "retype";
			fromType: CasePropertyDataType;
			toType: CasePropertyDataType;
	  }
	| { kind: "narrow-options"; removedOptions: string[] };

/**
 * Arguments for `CaseStore.applySchemaChange`. The
 * `caseTypeSchemas` map carries the prospective state — the
 * function regenerates the JSON Schema for the targeted case type,
 * then (when `change` is present) runs the matching per-row
 * migration. The caller-supplied-snapshot shape is the cross-store
 * saga seam: the orchestrator commits Firestore on success and
 * runs a compensating `applySchemaChange(previousState)` on
 * Firestore-commit failure.
 *
 * `property` is required when `change` is present and ignored
 * otherwise.
 */
export interface ApplySchemaChangeArgs {
	appId: string;
	caseType: string;
	caseTypeSchemas: ReadonlyMap<string, CaseType>;
	property?: string;
	change?: SchemaChangeKind;
}

/**
 * Per-row outcome from a `change`-driven migration. `migrated`
 * rows updated in place; `quarantined` rows moved to
 * `cases_quarantine`; `skipped` rows untouched (for `rename`, rows
 * lacking the `from` key; for the others, rows lacking the
 * targeted property). `failureReasons` carries the exact
 * `quarantine_reason` text per quarantined row in row-iteration
 * order — author-facing review UI reads these directly.
 */
export interface MigrationReport {
	migrated: number;
	quarantined: number;
	skipped: number;
	failureReasons: string[];
}

/**
 * Arguments for `CaseStore.generateSampleData`. Same `(appId,
 * caseType.name, seed)` tuple yields the same row sequence on
 * every call. `caseType` is the full definition — the heuristic
 * generator reads the property list from it; the implementation
 * uses `caseType.parent_type` to resolve parent ids when the
 * declaration carries one.
 */
export interface GenerateSampleDataArgs {
	appId: string;
	caseType: CaseType;
	count: number;
	seed: string;
}

/**
 * Arguments for `CaseStore.resetSampleData`. The implementation
 * picks a fresh seed at call time — callers reset specifically to
 * randomize the population. Tests that need reproducibility call
 * `generateSampleData` directly with a fixed seed.
 */
export interface ResetSampleDataArgs {
	appId: string;
	caseType: CaseType;
	count: number;
}

/**
 * The storage contract every consumer of case data binds against.
 * Construction is via the `withOwnerContext(userId)` factory —
 * there is no other constructor.
 */
export interface CaseStore {
	/**
	 * Predicate-driven SELECT with optional inline calculated-column
	 * projection. Default ordering (when `sort` is absent) is
	 * insertion order, driven by `case_id`'s UUID v7 timestamp prefix.
	 *
	 * Each `calculated` entry's `expression` compiles through
	 * `compileExpression` and lands in the SELECT keyed by
	 * `aliasFor(column.uuid)`; the result rows fold the evaluated
	 * values into `row.calculated[uuid]`. Postgres is the live
	 * runtime; calculated-column evaluation happens in the same
	 * SELECT as the row scan rather than post-processing in
	 * TypeScript. A future second evaluator would create a parity-
	 * tracking burden the project explicitly rules out at
	 * `feedback_max_subset_no_dimagi_litter.md`.
	 *
	 * Empty / absent `calculated` produces an empty `calculated: {}`
	 * map per row. The single result shape lets consumers read
	 * uniformly through the same `row.calculated[uuid]` accessor
	 * regardless of whether the query carried calc projections.
	 */
	query(args: QueryArgs): Promise<CaseRowWithCalculated[]>;

	/**
	 * Predicate-driven `COUNT(*)`. Returns the row population the
	 * `(appId, caseType, predicate?)` triple resolves to, scoped to
	 * the bound owner. The case-list authoring surface's Filters
	 * section uses this to render a "N cases pass this filter"
	 * counter without paying for a full `query` round-trip — the
	 * predicate compiles through the same `compilePredicate` stack
	 * as `query`, so the WHERE clause is identical to the predicate-
	 * narrowed `query` it pairs with.
	 *
	 * Predicate-free callers (the "no filter applied" preview state)
	 * pass `predicate: undefined`; the underlying SELECT collapses
	 * to a tenant-scoped count over the case-type partition.
	 */
	count(args: CountArgs): Promise<number>;

	/**
	 * Insert one case row. Validates `properties` against the
	 * case-type's JSON Schema before the row hits Postgres; derives
	 * the `case_indices` parent edge in the same transaction.
	 * Returns the generated `case_id`.
	 */
	insert(args: { appId: string; row: CaseInsert }): Promise<{
		caseId: string;
	}>;

	/**
	 * Insert a primary case + zero or more child cases atomically
	 * in one Postgres transaction. Children must NOT carry an
	 * explicit `parent_case_id` — the value is the primary's
	 * generated id, threaded by the implementation. Each child can
	 * be a different `case_type`. Returns the primary's id and the
	 * children's ids in input order.
	 *
	 * The empty-`children` case behaves like a single `insert` for
	 * the primary, still inside one transaction.
	 */
	insertWithChildren(args: {
		appId: string;
		primary: CaseInsert;
		children: ReadonlyArray<CaseInsert>;
	}): Promise<{
		primaryCaseId: string;
		childCaseIds: ReadonlyArray<string>;
	}>;

	/**
	 * Update a case row. JSONB-merges the patch into `properties`,
	 * re-validates against the schema, stamps `modified_on = now()`,
	 * re-derives `case_indices` if `parent_case_id` changed. Throws
	 * `CaseNotFoundError` when the bound owner cannot see the row.
	 */
	update(args: {
		appId: string;
		caseId: string;
		patch: CaseUpdate;
	}): Promise<void>;

	/**
	 * Close a case row. Stamps `closed_on = now()` on the first
	 * close; idempotent on row state — the UPDATE filters on
	 * `closed_on IS NULL`, so re-closing an already-closed case
	 * preserves the original timestamp. A status change on an
	 * already-closed row goes through `update`, not `close`. Does
	 * not delete — closed cases remain queryable.
	 */
	close(args: {
		appId: string;
		caseId: string;
		status?: string;
	}): Promise<void>;

	/**
	 * Traverse a `RelationPath` from the anchor to its destination
	 * cases. Self-paths return the anchor; ancestor walks return
	 * the chain's destination; subcase / any-relation walks return
	 * every matching child / both directions.
	 */
	traverse(args: {
		appId: string;
		caseId: string;
		via: RelationPath;
	}): Promise<CaseRow[]>;

	/**
	 * Sync the case-type's JSON Schema with the supplied prospective
	 * `caseTypeSchemas` map, optionally running a per-row migration.
	 * See `lib/case-store/CLAUDE.md` § "`applySchemaChange` runs in
	 * two phases" for the atomic-then-convergent shape.
	 */
	applySchemaChange(args: ApplySchemaChangeArgs): Promise<MigrationReport>;

	/**
	 * Drop the `case_type_schemas` row + every per-property
	 * expression index for `(appId, caseType)`. Used by the cross-
	 * store saga's compensation path to revert a case-type-addition
	 * Phase 1 commit when the Firestore commit fails: the prior
	 * blueprint has no `caseTypes` entry for this case type, so
	 * `applySchemaChange(prior)` cannot run (it would throw
	 * `CaseTypeNotInBlueprintError`); a direct DROP is the only
	 * way to honor the saga's "exactly the prior state" contract.
	 *
	 * Idempotent on every absence path — the schema row DELETE is
	 * a no-op when missing, and the per-property index drops use
	 * `IF EXISTS`. Calling against a non-existent case type is
	 * safe.
	 *
	 * Mirrors `applySchemaChange`'s two-phase shape: the schema-
	 * row DELETE runs in Phase A; the index drops run in Phase B
	 * via `DROP INDEX CONCURRENTLY IF EXISTS` so the index drops
	 * cannot run inside an outer transaction (per Postgres's
	 * `CREATE/DROP INDEX CONCURRENTLY` semantics — see
	 * `lib/case-store/CLAUDE.md` § "Why two phases").
	 */
	dropSchema(args: { appId: string; caseType: string }): Promise<void>;

	/**
	 * Generate `count` sample rows for `caseType` and bulk-insert
	 * them. Deterministic per `(app, caseType.name, seed)`. The
	 * implementation queries existing parent rows for any declared
	 * `caseType.parent_type` and threads them so generated children's
	 * parent linkages resolve to real ids. Whole batch lands in one
	 * Postgres transaction.
	 */
	generateSampleData(args: GenerateSampleDataArgs): Promise<{
		inserted: number;
	}>;

	/**
	 * Drop every row of `caseType.name` for the bound tenant + the
	 * matching `case_indices` edges, then regenerate from a fresh
	 * seed. The whole operation runs in one transaction — a
	 * mid-operation failure rolls back the deletion alongside the
	 * partial regeneration so the case-type's pre-call population
	 * stays intact.
	 */
	resetSampleData(args: ResetSampleDataArgs): Promise<{
		deleted: number;
		inserted: number;
	}>;
}

/**
 * Build the `name → CaseType` map every compiler in the stack reads
 * from `TermCompileContext.caseTypeSchemas`. The case-store's
 * `query` / `count` / `applySchemaChange` accept this map directly;
 * external callers pre-compute it from a `BlueprintDoc` at the
 * boundary so the case-store interface stays decoupled from the
 * full blueprint shape. A `null` `caseTypes` yields an empty map.
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
