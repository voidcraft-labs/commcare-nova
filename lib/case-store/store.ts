// lib/case-store/store.ts
//
// The `CaseStore` / `SchemaCaseStore` interfaces and their row / arg /
// result types — the type contracts the implementation
// (`./postgres/store.ts`) and the factories (`./projectContext.ts`)
// both depend on. This module imports from neither.
//
// Architectural contract: two interfaces, one implementation.
// `SchemaCaseStore` is the tenant-FREE schema-change slice (app-scoped
// `applySchemaChange` / `dropSchema`); `CaseStore extends
// SchemaCaseStore` adds the tenant-bound read/write surface.
// `withProjectContext(projectId, actorUserId)` binds the Project at
// construction so every read/write inherits the
// `WHERE project_id = <bound>` filter automatically and every insert
// stamps the new case's `owner_id = <actor>` (the CommCare case-owner —
// the reserved axis future location-based access carves on, distinct
// from the Project tenant filter); `withSchemaContext()` binds no
// tenant, for the schema-only callers.
//
// Methods take their narrow dependency directly: predicate / sort /
// calculated-column compilation needs the case-type schema map; the
// sample-data path needs one `CaseType` definition. Callers convert
// `BlueprintDoc → ReadonlyMap<string, CaseType>` at the boundary via
// `buildCaseTypeMap` so the interface stays decoupled from the full
// blueprint shape.

import type { Insertable, Selectable } from "kysely";
import {
	type CasePropertyDataType,
	type CaseType,
	type Column,
	materializableCaseTypes,
	type PersistableDoc,
} from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import type { TermBindings } from "./sql/compileTerm";
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

/**
 * The shape of a `cases` row as Postgres returns it. `project_id` is
 * omitted — it is the tenant key, never surfaced on a row (no consumer
 * reads it; the store binds it). `owner_id` stays — it is the CommCare
 * case-owner (the future location-access axis), a real row field.
 */
export type CaseRow = Omit<Selectable<CasesTable>, "project_id">;

/**
 * The shape an `insert` accepts. `case_id` is optional (omitting
 * it lets Postgres's `DEFAULT uuidv7()` fire). `app_id`, `project_id`,
 * and `owner_id` are omitted — `PostgresCaseStore` fills `app_id` from
 * the top-level argument, `project_id` from the bound Project, and
 * `owner_id` (the CommCare case-owner) from the bound actor; callers
 * cannot override the tenant key or the case-owner.
 *
 * `properties` widens to `JsonObject | string`. The implementation
 * parses + validates + re-stringifies either shape before the write
 * so callers may pass a typed object literal or a pre-stringified
 * payload uniformly.
 */
export type CaseInsert = Omit<
	Insertable<CasesTable>,
	"app_id" | "project_id" | "owner_id" | "properties"
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
	/**
	 * Open/closed lifecycle status. Normal app closure goes through
	 * `close()`, which owns the canonical `closed` value. This slot remains
	 * patchable so an importer can preserve historical lifecycle data and an
	 * explicit recovery flow can reopen with `{ status: "open", closed_on: null }`.
	 */
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
 * `lib/case-store/sql/dataTypeTokens.ts`'s `RESERVED_SCALAR_COLUMN_BY_PROPERTY`.
 *
 * `calculated` projections evaluate inline at the SQL layer keyed
 * by the column's `uuid`. The Postgres compiler is the single
 * evaluator — no parallel JS evaluator, no parity tests.
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
	/** Runtime values for input/session terms used by predicates, sort keys, or calculated projections. */
	bindings?: TermBindings;
	predicate?: Predicate;
	sort?: SortKey[];
	calculated?: ReadonlyArray<CalculatedColumn>;
	limit?: number;
	offset?: number;
	/**
	 * A case with an active (undismissed) kept value is HELD: it is
	 * excluded from every read by default, so the running app — case
	 * lists, search, counts, form loading — simply doesn't see it
	 * until review resolves its waiting values. Only the surfaces
	 * that EXIST to look at held cases opt in: the review screen's
	 * View case dialog and the builder's case-data population count.
	 * Defaulting to excluded means a new read surface inherits the
	 * hold without knowing it exists.
	 */
	includeHeld?: boolean;
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
	/** Runtime values for input/session terms used by the predicate. */
	bindings?: TermBindings;
	predicate?: Predicate;
	/** Same hold contract as `QueryArgs.includeHeld` — a count must
	 * agree with the row list its caller pairs it with. */
	includeHeld?: boolean;
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
 * migrations for. No arm ever removes a case row — a value the new
 * declaration cannot hold PARKS (`parked_case_values`: the value
 * moves out with its key, the row stays present and writable, and
 * the entry is recoverable by the review surface).
 *
 *   - `rename(renames)` — one or more JSONB key renames applied
 *     SIMULTANEOUSLY per row (each destination reads the row's
 *     pre-migration value), so same-batch chains, swaps, and
 *     name-reuse (A→B while B→C) resolve with no ordering
 *     hazard. Values cast into the destination declaration;
 *     blank values drop silently (nothing to keep), uncastable
 *     values and a merge-conflict's displaced source value park.
 *   - `retype(fromType, toType)` — per-row cast into the new type;
 *     an uncastable value parks and its key drops.
 *   - `narrow-options(removedOptions)` — a select value in
 *     `removedOptions` parks (a multi-select keeps its surviving
 *     elements; the FULL original array parks when any element was
 *     removed). Deliberate opt-in flush — stored values outside the
 *     current options are otherwise legitimate history (see the
 *     `single_select` rationale in the JSON Schema generator).
 */
export type SchemaChangeKind =
	| { kind: "rename"; renames: ReadonlyArray<{ from: string; to: string }> }
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
 * saga seam: the orchestrator commits the blueprint on success and
 * runs a compensating `applySchemaChange(previousState)` on
 * blueprint-commit failure.
 *
 * `property` is required for the `retype` / `narrow-options`
 * change arms (they target one property) and ignored otherwise —
 * a `rename` change carries its own targets in `renames`.
 *
 * `syncedSeq` (the `mutation_seq` this schema state derives from)
 * arms the monotone `synced_seq` guard: a sync whose `syncedSeq`
 * is LOWER than the row's recorded value is stale — a concurrent
 * writer already landed a fresher schema — so the ENTIRE call
 * no-ops (schema UPSERT + index DDL skipped). A forward sync
 * (higher or equal) UPSERTs and records the new `synced_seq`, so
 * two concurrently-added properties both survive. Absent: no guard —
 * the plain additive UPSERT (the pre-multiplayer path; the
 * migration-saga forward apply, which runs before its own committed
 * seq exists).
 *
 * `change` and `syncedSeq` are MUTUALLY EXCLUSIVE — a per-row
 * migration runs pre-commit (un-versioned); the additive gate
 * carries a seq and no migration. The implementation throws when
 * both are set, because the coarse gate's whole-call no-op could
 * otherwise silently skip a migration's per-row work on a stale seq.
 *
 * Independent of `change`, EVERY winning sync also runs per-property
 * transition detection over the stored↔derived schema diff: a
 * string↔array flip (the select single↔multi conversion) takes the
 * TOTAL reshape — a stored string scalar lifts to a one-element
 * array, an array space-joins into an unconstrained string target —
 * and every OTHER validation-semantics change (a `format` keyword,
 * string→integer, array→date, numeric→array via an in-transaction
 * stale-index pre-drop) takes the per-row cast whose uncastable
 * values park. This is detection over stored state, not caller
 * intent, so it composes with the additive gate: a stale-seq no-op
 * is safe because the fresher writer ran the same detection against
 * the same stored row in its own transaction. Rows a `change`
 * migration and the detection rewrite report on separate axes
 * (`migrated` / `reshaped` / `retyped`).
 */
export interface ApplySchemaChangeArgs {
	appId: string;
	caseType: string;
	caseTypeSchemas: ReadonlyMap<string, CaseType>;
	property?: string;
	change?: SchemaChangeKind;
	syncedSeq?: number;
}

/**
 * Per-row outcome of a sync's row rewrites, reported on three
 * separate row axes because one physical row can be rewritten by
 * more than one step: `migrated` counts rows a `change`-driven
 * migration updated in place, `reshaped` counts rows the
 * string↔array shape reshape rewrote, and `retyped` counts rows the
 * write-time retype detection cast — summing the axes can count a
 * row twice, so consumers report them side by side instead.
 * `skipped` counts rows a `change` migration left untouched (for
 * `rename`, rows lacking every renamed key; for the others, rows
 * lacking the targeted property).
 *
 * `parkedIds` are the `parked_case_values` entries this call
 * created — one per VALUE that could not be carried (its count is
 * the review-toast count). The saga's compensation path
 * consumes the ids to un-park on a failed blueprint commit.
 * `restored` counts previously-parked values this sync wrote BACK:
 * every winning sync ends by restoring any parked entry of the case
 * type whose original value conforms to the type's new schema and
 * whose key is free — so converting a property back (including via
 * undo) automatically recovers what the forward conversion set
 * aside. `failureReasons` carries the park events as
 * person-readable text in row-iteration order (a blank-value key
 * drop reports nothing).
 */
export interface MigrationReport {
	migrated: number;
	reshaped: number;
	retyped: number;
	restored: number;
	skipped: number;
	parkedIds: string[];
	failureReasons: string[];
}

/**
 * What a prospective retype of `(caseType, property)` into `toType`
 * would do to the stored rows — the consent preview every conversion
 * surface renders before the migration runs. Computed with the SAME
 * cast the migration applies, over the SAME population it migrates
 * (every row of the app's case type, held cases included — the
 * migration carries no hold filter), so preview and outcome cannot
 * drift. A concurrent write between preview and migration can still
 * shift the numbers; the post-conversion report remains the truth.
 */
export interface ConversionImpact {
	/** Rows holding a non-blank value under the property — the values
	 * the migration would touch (blank values drop silently, exactly
	 * as the migration drops them). */
	totalWithValue: number;
	/** Values the cast cannot carry — each would park and HOLD its
	 * case out of the app until review. */
	uncastable: number;
	/** Of the uncastable values' cases, how many ALREADY carry an
	 * active kept value (already held) — `uncastable - alreadyHeld`
	 * is the count of cases the conversion would newly hold. */
	alreadyHeld: number;
	/** Up to a handful of uncastable values in row order, for the
	 * consent surface to show what would be set aside. */
	samples: JsonValue[];
}

/**
 * Where a kept value stands against its property's CURRENT
 * declaration — the one server-computed classification the review
 * surface renders and acts on. `"fits"` alone permits Put back
 * (exactly the condition `restoreParkedValues` re-proves at write
 * time, so an offered Put back can only fail by losing a race);
 * `"blocked"` — the declaration exists but rejects the value;
 * `"undeclared"` — the schema no longer declares the property at all
 * (also the answer for an absent or unparseable stored schema:
 * restore refuses to guess). There is no occupancy arm: a case with
 * an active kept value is HELD out of the running app (see
 * `QueryArgs.includeHeld`), so the normal flow can't land a newer
 * value in the parked slot. Where a dismissal round-trip did (dismiss
 * releases → a form writes → move-back re-holds), the put back still
 * proceeds — it is a human decision — and archives the displaced
 * value as a new dismissed entry rather than destroying it.
 */
export type ParkedValueStanding = "fits" | "blocked" | "undeclared";

/**
 * One kept value as the review surface reads it — a
 * `parked_case_values` row joined to its live case, plus the
 * `standing` verdict computed server-side against the property's
 * CURRENT declaration (never promised from staleness).
 */
export interface ParkedValueEntry {
	id: string;
	caseId: string;
	/** The case's display name (`cases.case_name`). */
	caseName: string;
	caseType: string;
	property: string;
	originalValue: JsonValue;
	/** Person-readable — the same voice as `MigrationReport.failureReasons`. */
	reason: string;
	/** The transition captured at park time (a narrow-options park carries its select type on both sides). */
	fromType: CasePropertyDataType;
	toType: CasePropertyDataType;
	createdAt: Date;
	/** Soft archive — non-null when the user dismissed the entry. Dismissed entries stay listed (and explicitly restorable) under the Dismissed filter. */
	dismissedAt: Date | null;
	standing: ParkedValueStanding;
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
 * The tenant-free slice of the store: schema-change operations that
 * are APP-scoped (they apply to every row of an app's case type
 * regardless of which member created it), so they bind no Project.
 * `withSchemaContext()` returns this narrow type; callers that only
 * sync schemas (the cross-store saga, the chat-completion materialize,
 * the point-of-use heal) take it so they CANNOT reach a tenant-bound
 * read/write without a Project.
 */
export interface SchemaCaseStore {
	/**
	 * Sync the case-type's JSON Schema with the supplied prospective
	 * `caseTypeSchemas` map, optionally running a per-row migration.
	 *
	 * Two-phase shape — Phase A is one Kysely transaction that
	 * UPSERTs `case_type_schemas`, runs the detected per-property
	 * transitions, and runs the optional per-row migration
	 * (`rename` / `retype` / `narrow-options`); Phase B runs after
	 * Phase A commits and emits the per-property expression-index
	 * `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` diff.
	 * Phase B cannot share the Phase A transaction because
	 * non-CONCURRENTLY index builds scan the dead pre-migration
	 * tuples the per-row UPDATEs leave in the heap, and CONCURRENTLY
	 * index builds reject any outer transaction.
	 *
	 * Phase B failure leaves the next call's diff to converge —
	 * INVALID indexes flow through both `drops` and `creates` so a
	 * retry rebuilds them from scratch. Recovery is idempotent.
	 *
	 * App-scoped: the schema row + per-row migration cover all of the
	 * app's rows for the case type, across every member — a schema
	 * change is an app-wide event, not a per-tenant one.
	 */
	applySchemaChange(args: ApplySchemaChangeArgs): Promise<MigrationReport>;

	/**
	 * Preview what retyping `(caseType, property)` to `toType` would
	 * do to the stored rows — see {@link ConversionImpact}. Read-only,
	 * app-scoped like `applySchemaChange` (the migration it previews
	 * covers every member's rows), and computed with the migration's
	 * own cast so an edge this reports clean cannot park at migration
	 * time for the same data.
	 */
	conversionImpact(args: {
		appId: string;
		caseType: string;
		property: string;
		toType: CasePropertyDataType;
	}): Promise<ConversionImpact>;

	/**
	 * Write parked values back under their keys and delete the restored
	 * entries — the saga's compensation half for a failed blueprint
	 * commit, consuming `MigrationReport.parkedIds` from the forward
	 * apply. Call only AFTER the schema state the values were valid
	 * under is restored. An entry whose key meanwhile holds a real
	 * concurrent value is KEPT (reported in `kept`) rather than
	 * clobbered or deleted.
	 */
	unparkValues(args: {
		appId: string;
		ids: ReadonlyArray<string>;
	}): Promise<{ restored: number; kept: number }>;

	/**
	 * Drop the `case_type_schemas` row + every per-property
	 * expression index for `(appId, caseType)`. Used by the cross-
	 * store saga's compensation path to revert a case-type-addition
	 * Phase 1 commit when the blueprint commit fails: the prior
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
	 * cannot run inside an outer transaction (Postgres rejects
	 * CONCURRENTLY index DDL inside a transaction).
	 */
	dropSchema(args: { appId: string; caseType: string }): Promise<void>;
}

/**
 * The full storage contract every consumer of case DATA binds
 * against — the tenant-bound read/write surface plus the schema
 * operations it inherits from {@link SchemaCaseStore}. Construction
 * is via the `withProjectContext(projectId, actorUserId)` factory,
 * which binds the Project the reads/writes scope to and the actor
 * stamped as each new row's `owner_id`.
 */
export interface CaseStore extends SchemaCaseStore {
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
	 * TypeScript. A second evaluator would create a parity-tracking
	 * burden the project rules out — Postgres is the only evaluator.
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
	 * the bound Project. The case-list authoring surface's Filters
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
	 * `CaseNotFoundError` when the bound Project cannot see the row.
	 */
	update(args: {
		appId: string;
		caseId: string;
		patch: CaseUpdate;
	}): Promise<void>;

	/**
	 * Close a case row. Atomically stamps `closed_on = now()` and the
	 * canonical built-in lifecycle `status = "closed"` on the first close.
	 * Re-closing a previously inconsistent row repairs its status while
	 * preserving the original closure timestamp. Re-closing a consistent row
	 * is idempotent. Does not delete — closed cases remain queryable.
	 * Historical import and explicit reopen flows use `update` to write their
	 * paired lifecycle data.
	 */
	close(args: { appId: string; caseId: string }): Promise<void>;

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
	 * matching `case_indices` edges, detach surviving tenant-local children
	 * whose deleted parent cannot be preserved, then regenerate from a fresh
	 * seed. The whole operation runs in one transaction — a
	 * mid-operation failure rolls back the deletion alongside the
	 * partial regeneration so the case-type's pre-call population
	 * stays intact.
	 */
	resetSampleData(args: ResetSampleDataArgs): Promise<{
		deleted: number;
		inserted: number;
	}>;

	/**
	 * Every kept value of the case type, newest first, with the
	 * restore verdict computed against the CURRENTLY-stored schema —
	 * see {@link ParkedValueEntry}. Tenant-bound through the `cases`
	 * join (an entry is only as visible as its case row).
	 */
	listParkedValues(args: {
		appId: string;
		caseType: string;
	}): Promise<ParkedValueEntry[]>;

	/**
	 * The user-driven restore: write the named entries' values back
	 * under their keys and delete the restored entries. Same safety
	 * core as {@link SchemaCaseStore.unparkValues} — row exists, value
	 * conforms to the currently-stored schema; a blocked entry is
	 * KEPT — plus the tenant gate (an id whose case row sits outside
	 * the bound Project counts as `kept`, never touched) and the
	 * dismissed gate (a DISMISSED id counts as `kept`: its case may be
	 * live with a peer's replacement under the slot, so a stale
	 * client's Put back never overwrites — move back to review first).
	 * Unlike the automatic restores, this human decision OVERWRITES an
	 * occupied slot; a displaced value that isn't redundant with the
	 * original is archived as a new dismissed entry (`displaced`
	 * counts them), so no overwrite ever destroys data.
	 */
	restoreParkedValues(args: {
		appId: string;
		ids: ReadonlyArray<string>;
	}): Promise<{ restored: number; kept: number; displaced: number }>;

	/**
	 * Toggle the soft archive on the named entries. Dismissing never
	 * deletes — the entry leaves the active list (and the discovery
	 * badge count, and the winning-sync auto-restore's candidate set)
	 * but stays findable and restorable under the Dismissed filter;
	 * `dismissed: false` is the undo. Returns the toggled count;
	 * tenant-gated like {@link CaseStore.restoreParkedValues}.
	 */
	setParkedValuesDismissed(args: {
		appId: string;
		ids: ReadonlyArray<string>;
		dismissed: boolean;
	}): Promise<number>;

	/**
	 * The "Replace" path: write `value` to the entry's case property
	 * through the standard validated `update` (schema validation,
	 * orphan shed, `modified_on` stamp), then dismiss the entry — the
	 * original value stays readable under the Dismissed filter rather
	 * than deleting. Throws `ParkedValueNotFoundError` when the bound
	 * Project cannot see the entry and
	 * `CasePropertiesValidationError` when the value doesn't fit the
	 * property's current declaration.
	 */
	replaceParkedValue(args: {
		appId: string;
		id: string;
		value: JsonValue;
	}): Promise<void>;
}

/**
 * Build the `name → CaseType` map every compiler in the stack reads
 * from `TermCompileContext.caseTypeSchemas`. The case-store's
 * `query` / `count` / `applySchemaChange` accept this map directly;
 * external callers pre-compute it from a blueprint at the boundary so
 * the case-store interface stays decoupled from the full blueprint
 * shape. A `null` `caseTypes` yields an empty map.
 *
 * The entries are the MATERIALIZABLE case types
 * (`lib/domain/effectiveCaseTypes.ts::materializableCaseTypes`) —
 * declared annotations with writer-derived `data_type`s filled, plus
 * writer-derived entries, WITHOUT the implicit standard entries. Both
 * halves are load-bearing:
 *
 *   - Derived types keep the compiler in lockstep with the type
 *     checker: a comparison the checker admits as date-typed compiles
 *     with a date cast, and a writer-derived property resolves in
 *     `compileTerm.lookupDataType` rather than throwing.
 *   - Standard entries stay OUT because their values are not stored
 *     in the JSONB `properties` document (`date_opened` lives in the
 *     `opened_on` column): a map entry would make a reference compile
 *     to a silently-NULL JSONB read, and on the schema-write side
 *     would put `format` constraints + expression indexes on keys
 *     inserts never carry. Standard-name references resolve through
 *     `sql/dataTypeTokens.ts::RESERVED_SCALAR_COLUMN_BY_PROPERTY`
 *     onto their scalar columns BEFORE the map is consulted, so
 *     `lookupDataType` never sees them.
 *
 * Reads `caseTypes` + `fields` only — never the in-memory
 * `fieldParent` index — so the parameter is the persisted shape
 * (`PersistableDoc`). A caller holding the fuller in-memory
 * `BlueprintDoc` passes it as-is (it's a subtype); a caller holding
 * only the persisted shape needs no cast.
 */
export function buildCaseTypeMap(
	blueprint: PersistableDoc | undefined,
): ReadonlyMap<string, CaseType> {
	if (blueprint === undefined) {
		return new Map();
	}
	const map = new Map<string, CaseType>();
	for (const caseType of materializableCaseTypes(blueprint)) {
		map.set(caseType.name, caseType);
	}
	return map;
}
