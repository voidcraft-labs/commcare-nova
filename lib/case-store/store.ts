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

import type { Insertable, Selectable } from "kysely";
import type {
	BlueprintDoc,
	CalculatedColumn,
	CasePropertyDataType,
	CaseType,
} from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { CaseTypeNotInBlueprintError } from "./errors";
import type { CasesTable, JsonObject, JsonValue } from "./sql/database";

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
 * Arguments for `CaseStore.query`.
 *
 * `blueprint` is required when `predicate` or `sort` reads a case
 * property — the compiler resolves the `prop` term's `data_type`
 * to pick the column cast. Predicate-free, sort-free queries (or
 * queries whose operands touch only reserved scalar columns at
 * `lib/case-store/sql/dataTypeTokens.ts`'s `RESERVED_SCALAR_COLUMNS`)
 * work without one.
 */
export interface QueryArgs {
	appId: string;
	caseType: string;
	blueprint?: BlueprintDoc;
	predicate?: Predicate;
	sort?: SortKey[];
	limit?: number;
	offset?: number;
}

/**
 * Arguments for `CaseStore.queryWithCalculated`. Same shape as
 * `QueryArgs` plus the calculated-column projection list. Each
 * column's `expression` is compiled inline as a SELECT projection
 * keyed by the column's `id`; the result row carries a `calculated`
 * map keyed by the same id.
 *
 * `blueprint` is required (not optional like `QueryArgs`) because
 * every calculated-column expression compiles through
 * `compileExpression`, which delegates to `compileTerm` for `prop`
 * leaf reads — and the term compiler resolves the property's
 * `data_type` from the case-type schema map. A calculated expression
 * that reads no properties (`today()` / `now()` / arith over
 * literals) would compile without a blueprint, but the typed
 * blueprint slot is the structural defense: the slot is required
 * upstream so the compiler stack never reaches an undefined schema
 * map under realistic authoring.
 */
export interface QueryWithCalculatedArgs {
	appId: string;
	caseType: string;
	blueprint: BlueprintDoc;
	calculated: ReadonlyArray<CalculatedColumn>;
	predicate?: Predicate;
	sort?: SortKey[];
	limit?: number;
	offset?: number;
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
 * Result row shape for `queryWithCalculated`. Folds the calculated
 * map ONTO the row rather than returning a sidecar array — sidecar
 * arrays couple by index, and any future filter / sort transform
 * applied to one half would silently misalign the two. One row,
 * one calculated map, never desyncs.
 *
 * The `calculated` map is keyed by the calculated column's `id`
 * (as supplied in `QueryWithCalculatedArgs.calculated[i].id`); a
 * calculated column whose expression evaluates to SQL NULL emits
 * `id → null` (NOT omitted from the map). Consumers can therefore
 * distinguish "column absent from the query" (key not in map) from
 * "column evaluated to null" (`map[id] === null`).
 *
 * Two collision classes the projection must handle:
 *
 *   1. **Calculated id vs `cases` column collision.** An author
 *      can type a reserved column name (`case_name`, `case_id`,
 *      `case_type`, `owner_id`, `status`, `app_id`, `opened_on`,
 *      `closed_on`, `modified_on`, `parent_case_id`, `properties`)
 *      into the calculated-column id field. Without protection,
 *      Postgres allows duplicate output names; pg-driver's row
 *      deserializer keeps the LAST occurrence (the calculated
 *      expression's value); the row's actual scalar value is
 *      silently corrupted. `PostgresCaseStore.queryWithCalculated`
 *      defends structurally by emitting calculated aliases under
 *      a fixed `__nova_calc__<id>` prefix in the SELECT, then
 *      unprefixing during the row partition — the wire and the
 *      consumer-facing key live in disjoint keyspaces, so this
 *      collision class is impossible regardless of the author's
 *      chosen id.
 *
 *   2. **Duplicate id across siblings.** When two `calculated`
 *      entries share the same `id`, the SELECT emits two columns
 *      under the same `__nova_calc__<id>` alias; pg-driver keeps
 *      the last and the second occurrence's value overwrites the
 *      first's. The `CalculatedColumnEditor` validates id
 *      uniqueness across siblings upstream — the display-vs-
 *      validity parity gate flags duplicates before they reach
 *      the action — so the SQL layer trusts the upstream gate for
 *      this class.
 *
 *   3. **Alias overflow past Postgres' 63-byte identifier cap.**
 *      Postgres silently truncates identifiers at
 *      `NAMEDATALEN - 1` (63 bytes). The composed alias
 *      `__nova_calc__<id>` (13 bytes of prefix) gets truncated
 *      when `id` pushes the total over the cap; the row-partition
 *      step uses the FULL pre-truncation alias to read each
 *      calculated value, misses the truncated wire-side key, and
 *      silently emits `null` for every row. Two ids matching in
 *      the truncation prefix collide on the same wire alias.
 *      `queryWithCalculated` defends with a pre-projection byte-
 *      length check that throws a `compilerBugMessage` naming
 *      the over-cap alias — same shape as the `indexName` defense
 *      under `applySchemaChange`. The editor's id-uniqueness gate
 *      is the upstream cover; this throw catches programmatic
 *      surfaces that bypass the gate.
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
 * Arguments for `CaseStore.applySchemaChange`. The `blueprint`
 * carries the prospective state — the function regenerates the
 * JSON Schema from it, then (when `change` is present) runs the
 * matching per-row migration. The caller-supplied-snapshot shape
 * is the cross-store saga seam: the orchestrator commits Firestore
 * on success and runs a compensating `applySchemaChange(previousState)`
 * on Firestore-commit failure.
 *
 * `property` is required when `change` is present and ignored
 * otherwise.
 */
export interface ApplySchemaChangeArgs {
	appId: string;
	caseType: string;
	blueprint: BlueprintDoc;
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
 * The storage contract every consumer of case data binds against.
 * Construction is via the `withOwnerContext(userId)` factory —
 * there is no other constructor.
 */
export interface CaseStore {
	/**
	 * Predicate-driven SELECT. Default ordering (when `sort` is
	 * absent) is insertion order, driven by `case_id`'s UUID v7
	 * timestamp prefix.
	 */
	query(args: QueryArgs): Promise<CaseRow[]>;

	/**
	 * Predicate-driven SELECT with calculated-column projection.
	 * Same semantics as `query` plus per-row evaluation of every
	 * calculated column's expression at the SQL layer — each
	 * `CalculatedColumn.expression` compiles through
	 * `compileExpression` and lands in the SELECT keyed by
	 * `aliasFor(column.id)`. The result rows fold the evaluated
	 * values into the row's `calculated` map.
	 *
	 * Postgres is the live runtime; calculated-column evaluation
	 * happens in the same SELECT as the row scan rather than
	 * post-processing in TypeScript. A future second evaluator
	 * would create a parity-tracking burden the project explicitly
	 * rules out at `feedback_max_subset_no_dimagi_litter.md`.
	 *
	 * The empty `calculated` arm behaves like `query` plus an empty
	 * `calculated: {}` map per row. Calling with a long calculated
	 * list creates one column per entry; Postgres has no per-row
	 * value-budget on SELECT projections, but consumers should keep
	 * the count proportional to the case list's authored shape.
	 */
	queryWithCalculated(
		args: QueryWithCalculatedArgs,
	): Promise<CaseRowWithCalculated[]>;

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
	 * blueprint state, optionally running a per-row migration. See
	 * `lib/case-store/CLAUDE.md` § "`applySchemaChange` runs in two
	 * phases" for the atomic-then-convergent shape.
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
	 * them. Deterministic per `(app, caseType, seed)`. The
	 * implementation queries existing parent rows for any declared
	 * `parent_type` and threads them so generated children's parent
	 * linkages resolve to real ids. Whole batch lands in one
	 * Postgres transaction.
	 */
	generateSampleData(args: GenerateSampleDataArgs): Promise<{
		inserted: number;
	}>;

	/**
	 * Drop every row of `caseType` for the bound tenant + the
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
 * Arguments for `CaseStore.generateSampleData`. Same `(appId,
 * caseType, seed)` tuple yields the same row sequence on every
 * call.
 */
export interface GenerateSampleDataArgs {
	appId: string;
	caseType: string;
	count: number;
	seed: string;
	blueprint: BlueprintDoc;
}

/**
 * Arguments for `CaseStore.resetSampleData`. The implementation
 * picks a fresh seed at call time — callers reset specifically to
 * randomize the population. Tests that need reproducibility call
 * `generateSampleData` directly with a fixed seed.
 */
export interface ResetSampleDataArgs {
	appId: string;
	caseType: string;
	count: number;
	blueprint: BlueprintDoc;
}

/**
 * Locate a case type within a blueprint by name. Throws
 * `CaseTypeNotInBlueprintError` when the case type is absent. The
 * typed error reaches Server Actions on the running-app view so a
 * stale blueprint snapshot (case type deleted in the editor between
 * mount and click) maps to a `missing-case-type` arm rather than
 * the wrapper-jargon shape used for true invariant violations.
 *
 * Consumed by `PostgresCaseStore.applySchemaChange` and
 * `HeuristicCaseGenerator.generate`.
 */
export function findCaseTypeOrThrow(
	blueprint: BlueprintDoc,
	appId: string,
	caseType: string,
): CaseType {
	const found = blueprint.caseTypes?.find((c) => c.name === caseType);
	if (!found) {
		throw new CaseTypeNotInBlueprintError(appId, caseType);
	}
	return found;
}

/**
 * Build the `name → CaseType` map every compiler in the stack reads
 * from `TermCompileContext.caseTypeSchemas`. A `null` `caseTypes`
 * yields an empty map.
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
