// lib/case-store/store.ts
//
// The `CaseStore` / `SchemaCaseStore` interfaces and their row / arg /
// result types — the type contracts the implementation
// (`./postgres/store.ts`) and the factories (`./projectContext.ts`)
// both depend on. This module imports from neither.
//
// Architectural contract: two interfaces, one implementation.
// `SchemaCaseStore` is the actor-free schema-change slice (app-scoped
// `applySchemaChange`); `CaseStore extends
// SchemaCaseStore` adds the tenant-bound read/write surface.
// `withProjectContext(projectId, actorUserId, ownerId)` binds the Project at
// construction so every read/write inherits the
// `WHERE project_id = <bound>` filter automatically and every insert
// stamps the new case's `owner_id = <owner>` (the CommCare case-owner —
// the reserved axis future location-based access carves on, distinct
// from the Project tenant filter); `withSchemaContext()` binds no Project at
// construction, but every schema write dynamically fences the app's current
// Project placement in its transaction.
//
// Methods take their narrow dependency directly: predicate / sort /
// calculated-column compilation needs the case-type schema map; the
// sample-data path needs one `CaseType` definition. Callers convert
// `BlueprintDoc → ReadonlyMap<string, CaseType>` at the boundary via
// `buildCaseTypeMap` so the interface stays decoupled from the full
// blueprint shape.

import type { Insertable, Selectable, Transaction } from "kysely";
import {
	type CasePropertyDataType,
	type CaseType,
	type Column,
	materializableCaseTypes,
	type PersistableDoc,
	USERCASE_CASE_TYPE,
	usercaseCaseType,
} from "@/lib/domain";
import type {
	Predicate,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import type { LookupTableSchemas } from "./sql/compileLookup";
import type { TermBindings } from "./sql/compileTerm";
import type {
	CaseIndicesTable,
	CasesTable,
	Database,
	JsonObject,
	JsonValue,
} from "./sql/database";
import type {
	ApplySubmissionArgs,
	SubmissionEnvelopeResult,
} from "./submission";

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

/** One direct case-index edge whose source and ancestor both belong to the
 * bound app and Project. The target type is persisted on the edge because
 * CommCare keeps the original CaseIndex type even if the target is retyped. */
export type CaseIndexRow = Selectable<CaseIndicesTable>;

export interface DeviceCaseDatabase {
	readonly rows: readonly CaseRow[];
	readonly indices: readonly CaseIndexRow[];
	/** Exact retained stored-schema types for every projected case type. Optional
	 * only because durable submission receipts written before this slot exist. */
	readonly propertyTypes?: Readonly<
		Record<string, Readonly<Record<string, CasePropertyDataType>>>
	>;
}

/**
 * The shape an `insert` accepts. `case_id` is optional (omitting
 * it lets Postgres's `DEFAULT uuidv7()` fire). `app_id`, `project_id`,
 * and `owner_id` are omitted — `PostgresCaseStore` fills `app_id` from
 * the top-level argument, `project_id` from the bound Project, and
 * `owner_id` (the CommCare case-owner) from the bound owner; callers
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
	/** External-system identity. Routed to `external_id`, never JSONB; `""` is an explicit write. */
	readonly external_id?: string;
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

type CaseUpdateWithoutParent = Omit<CaseUpdate, "parent_case_id"> & {
	readonly parent_case_id?: undefined | null;
};

/**
 * A parent assignment is valid by construction only when it carries the edge
 * relationship that the caller derived from its authoritative source. Ordinary
 * form actions use the committed case-type declaration; advanced case-operation
 * links bypass this API and persist their authored relationship directly.
 */
export type CaseUpdateArgs = {
	readonly appId: string;
	readonly caseId: string;
} & (
	| {
			readonly patch: Omit<CaseUpdate, "parent_case_id"> & {
				readonly parent_case_id: string;
			};
			readonly parentRelationship: "child" | "extension";
	  }
	| {
			readonly patch: CaseUpdateWithoutParent;
			readonly parentRelationship?: never;
	  }
);

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
 * Restrict a read to what one worker's device would actually hold.
 *
 * CommCare does not filter a restore by ownership — it takes a fixpoint over
 * the case-index graph that ownership only SEEDS, so this is not
 * `owner_id IN (…)` and cannot be expressed as one.
 * `lib/case-store/sql/compileRestoreScope.ts` is the rule and carries the
 * CommCare citations.
 *
 * Absent means today's behavior: the whole tenant. That is the contract for
 * every AUTHORING surface — the case workspace, sample data, the property
 * rename preflight, and the automation sweep all read the tenant, because
 * none of them is standing at a device. Only the running preview passes one.
 */
export interface RestoreScope {
	/**
	 * The worker's owner ids: their own id plus one per case-sharing group
	 * (`lib/organization/ownerSets.ts`, mirroring `CouchUser.get_owner_ids`).
	 * Never empty — every worker owns at least their own id, and the closure
	 * refuses an empty set rather than answering it with an empty restore.
	 */
	readonly ownerIds: readonly string[];
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
	/**
	 * Restrict a nested-menu read to cases directly linked to this selected
	 * parent through any non-extension case index. This is runtime selection
	 * state, not authored predicate data: CommCare emits
	 * `index/*[not(@relationship='extension')] = <selected case>` without
	 * naming one index identifier, and Preview must use that exact population.
	 */
	parentCaseId?: string;
	caseTypeSchemas?: ReadonlyMap<string, CaseType>;
	/**
	 * Rows-free lookup definitions (table id → column id → data type)
	 * for predicates, sort keys, or calculated projections carrying
	 * lookup-table carriers. Required exactly when the ASTs reference a
	 * lookup table — a carrier compiling without it throws the
	 * missing-context invariant. Project the same definitions snapshot
	 * validation used so casts match the type checker.
	 */
	lookupTableSchemas?: LookupTableSchemas;
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
	/**
	 * Read as one worker's device would. See {@link RestoreScope} — absent is
	 * the whole tenant, which is what every authoring surface wants.
	 */
	restoreScope?: RestoreScope;
}

/**
 * One cluster of a grouped case list, in the order the runtime draws
 * them.
 *
 * `key` is the group key exactly as the device computes it: the target
 * of the named case index, or the EMPTY STRING for a case that carries
 * no such index. That is not a Nova convention —
 * `string(./index/parent)` evaluates to `""` on a parentless child and
 * CommCare's clustering map accepts it as an ordinary key
 * (`commcare-core/.../cases/entity/NodeEntityFactory::getEntity`
 * evaluates the group function to a `String`;
 * `.../util/screen/EntityScreenHelper::groupEntities` keys a `HashMap`
 * on it). Every case missing the index therefore lands in ONE group.
 * There is no "ungrouped" concept anywhere in the engine, so there is
 * none here: inventing a synthetic bucket would make the preview show
 * something no device shows.
 */
export interface CaseGroup {
	readonly key: string;
	readonly rows: readonly CaseRowWithCalculated[];
}

/**
 * One page of a grouped case list.
 *
 * `totalGroups` is the pager's denominator and comes from the same
 * statement as `groups`, so a page and its page count cannot describe
 * two different result sets. `totalRows` is what lets a surface say how
 * many cases those groups hold — which matters here in a way it does
 * not for an ordinary page, because **a grouped page is unbounded in
 * rows**: `formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
 * counts group boundaries, so a window of N groups returns however many
 * rows those groups contain. That is the platform's behavior, faithfully
 * reproduced, not a bug to work around.
 */
export interface GroupedQueryResult {
	readonly groups: readonly CaseGroup[];
	readonly totalGroups: number;
	readonly totalRows: number;
}

/**
 * Arguments for `CaseStore.queryGrouped` — an ordinary case-list read
 * plus the grouping, whose window counts GROUPS rather than rows.
 *
 * The window lives here rather than on `QueryArgs.limit` / `.offset`
 * precisely so its unit is the shape and not a comment. CommCare
 * reinterprets one pair of numbers for both meanings; Nova does not,
 * because a caller that mixed them up would silently return the wrong
 * page rather than fail.
 */
export interface GroupedQueryArgs extends Omit<QueryArgs, "limit" | "offset"> {
	/**
	 * The case-index identifier whose target is the group key — the
	 * storage-side reading of the wire's `string(./index/<id>)`.
	 */
	readonly indexIdentifier: string;
	/** Groups to skip. */
	readonly groupOffset: number;
	/** Groups to return. Every returned group is whole. */
	readonly groupLimit: number;
}

/**
 * Arguments for `CaseStore.count`. Subset of `QueryArgs` — `count`
 * never sorts, never paginates, and never projects calculated
 * columns. The case-type arm returns the population the
 * `(appId, caseType, predicate?)` triple resolves to. The owner arm
 * returns every retained row for `(appId, ownerId)` across current and
 * retired case types without requiring a materialized schema.
 *
 * `caseTypeSchemas` is required when `predicate` reads a case
 * property (same data-type-resolution contract as `QueryArgs`).
 * Predicate-free callers pass `predicate: undefined`; the
 * implementation skips the WHERE clause entirely so the count
 * collapses to a sequential / index scan over the case-type
 * partition.
 */
export type CountArgs =
	| {
			appId: string;
			caseType: string;
			ownerId?: never;
			/** Same selected-parent population contract as `QueryArgs.parentCaseId`. */
			parentCaseId?: string;
			caseTypeSchemas?: ReadonlyMap<string, CaseType>;
			/** Same contract as `QueryArgs.lookupTableSchemas`. */
			lookupTableSchemas?: LookupTableSchemas;
			/** Runtime values for input/session terms used by the predicate. */
			bindings?: TermBindings;
			predicate?: Predicate;
			/** Local-only automation criterion group. HQ property comparisons,
			 * relation selection, blankness, and calendar-date arithmetic differ
			 * intentionally from general case search, so these ephemeral leaves stay
			 * explicit. The same Kysely query composes the group and preserves ALL/ANY;
			 * this is not a second persisted automation schema. A host-scoped
			 * criterion also makes `count` refuse with
			 * `AutomationHostAmbiguityError` when an otherwise-visible open target
			 * case has more than one distinct extension host; that preflight and
			 * the count share one PostgreSQL statement snapshot. */
			automationCriteria?: {
				/** True when the locally matched criteria read through HQ's unordered
				 * first extension host. Actions are setup guidance, not local execution. */
				requiresUnambiguousHost: boolean;
				operator: "all" | "any";
				dates: readonly {
					property: string;
					days: number;
					matchType:
						| "date-days-before"
						| "date-days-lte"
						| "date-days-gt"
						| "date-days";
					scope: "case" | "parent" | "host";
				}[];
				comparisons: readonly {
					property: string;
					value: string;
					equal: boolean;
					scope: "case" | "parent" | "host";
				}[];
				regexes: readonly { property: string; pattern: string }[];
				blankness: readonly {
					property: string;
					hasValue: boolean;
					scope: "case" | "parent" | "host";
				}[];
				closedParents: readonly {
					identifier: string;
					relationship: "child" | "extension";
				}[];
				/** One HQ LocationFilterDefinition per entry, lowered to the exact
				 * local owner identities it can match: the selected location/subtree
				 * plus personas whose primary location is inside it. */
				locationOwnerSets: readonly (readonly string[])[];
			};
			/** Same hold contract as `QueryArgs.includeHeld` — a count must
			 * agree with the row list its caller pairs it with. */
			includeHeld?: boolean;
			missingIndexIdentifier?: never;
			/**
			 * Same restore contract as `QueryArgs.restoreScope`, and for the same
			 * reason as `includeHeld`: a count that saw a different population
			 * than its row list surfaces as a count-versus-rows mismatch.
			 *
			 * The automation criteria above never carry one. They model HQ's
			 * SERVER-side rule sweep, which runs against every case in the
			 * domain — a restore is a fact about a device, and no device is
			 * involved.
			 */
			restoreScope?: RestoreScope;
	  }
	| {
			/**
			 * Count every retained case owned by one CommCare worker, across
			 * current and retired case types. This is deliberately not a
			 * predicate arm: it needs no materialized schema to inspect the
			 * reserved scalar `owner_id`.
			 */
			appId: string;
			ownerId: string;
			caseType?: never;
			parentCaseId?: never;
			automationCriteria?: never;
			caseTypeSchemas?: never;
			lookupTableSchemas?: never;
			bindings?: never;
			predicate?: never;
			includeHeld?: boolean;
			missingIndexIdentifier?: never;
	  }
	| {
			/**
			 * Count the cases of one type that carry NO case index with this
			 * identifier — the population a grouped case list collects into
			 * its single empty-key group.
			 *
			 * A measurement, deliberately not a predicate arm. Which cases
			 * lack an index is runtime data, so it can never be a validator
			 * finding: a rule keyed on it would let a worker linking the last
			 * unlinked case silently repair an app, and unlinking one
			 * silently break it. The authoring surface states the consequence
			 * and shows this number beside it
			 * (`docs/plans/complex-app/00-contracts.md` § What the commit gate
			 * may read).
			 *
			 * It counts what the AUTHOR governs rather than what the running
			 * app reaches, so held rows are included by default, matching the
			 * Case data manager's population count rather than the running
			 * list's probe.
			 */
			appId: string;
			caseType: string;
			missingIndexIdentifier: string;
			ownerId?: never;
			parentCaseId?: never;
			automationCriteria?: never;
			caseTypeSchemas?: never;
			lookupTableSchemas?: never;
			bindings?: never;
			predicate?: never;
			includeHeld?: never;
	  };

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
 * The two generic change-shape arms `applySchemaChange` runs per-row
 * migrations for. No arm ever removes a case row — a value the new
 * declaration cannot hold PARKS (`parked_case_values`: the value
 * moves out with its key, the row stays present and writable, and
 * the entry is recoverable by the review surface).
 *
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
 * migration. Case-property renames do not use this generic change channel;
 * their explicit command has a dedicated all-rows transactional API.
 *
 * `property` is required for both generic change arms.
 *
 * `syncedSeq` (the `mutation_seq` this schema state derives from)
 * arms the monotone `synced_seq` guard: a sync whose `syncedSeq`
 * is LOWER than the row's recorded value is stale — a concurrent
 * writer already landed a fresher schema — so the ENTIRE call
 * no-ops (schema UPSERT + index DDL skipped). A forward sync
 * (higher or equal) UPSERTs and records the new `synced_seq`, so
 * two concurrently-added properties both survive. Absent: no guard —
 * the plain additive UPSERT path.
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
 * `skipped` counts rows a generic `change` migration left untouched because
 * they lack the targeted property.
 *
 * `parkedIds` are the `parked_case_values` entries this call
 * created — one per VALUE that could not be carried (its count is
 * the review-toast count).
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
 * The result prepared by schema/data Phase A plus its post-commit
 * concurrent-index completion. The token becomes durable only when the caller's
 * transaction commits; `completeAfterCommit` must run after that point.
 */
export interface PreparedSchemaChangePhaseB {
	readonly report: MigrationReport;
	readonly completeAfterCommit: () => Promise<void>;
}

/**
 * One guarded Blueprint commit's case-type retirement plan. The caller passes
 * a fallback materializable catalog so Phase A can preserve a contract even
 * when an older post-commit materialization never created the schema row. The
 * guarded commit supplies its freshly locked PRIOR catalog; the historical
 * backfill can rely on the active stored row it is retiring.
 */
export interface ApplyCaseTypeSchemaRetirementArgs {
	readonly appId: string;
	readonly desiredSeq: number;
	readonly caseTypes: readonly string[];
	readonly fallbackCaseTypeSchemas: ReadonlyMap<string, CaseType>;
}

/**
 * Retirement's durable state is complete in Phase A. Phase B only converges
 * expression indexes to the inactive type's empty desired set.
 */
export interface PreparedCaseTypeSchemaRetirementPhaseB {
	readonly caseTypes: readonly string[];
	readonly completeAfterCommit: () => Promise<void>;
}

export interface CasePropertyRenameEntry {
	readonly caseType: string;
	readonly from: string;
	readonly to: string;
}

export interface ApplyCasePropertyRenameArgs {
	readonly appId: string;
	readonly desiredSeq: number;
	readonly caseTypeSchemas: ReadonlyMap<string, CaseType>;
	readonly entries: readonly CasePropertyRenameEntry[];
}

export interface CasePropertyRenameReport {
	/** Live case rows whose JSON property document changed. */
	readonly renamedRows: number;
	/** Parked values relabeled, including dismissed entries. */
	readonly renamedParkedValues: number;
	readonly caseTypes: readonly string[];
}

export interface PreparedCasePropertyRenamePhaseB {
	readonly report: CasePropertyRenameReport;
	/**
	 * Correctness-neutral expression-index convergence. The row, parked-value,
	 * schema, Blueprint, and accepted-mutation changes are already one durable
	 * transaction before this runs.
	 */
	readonly completeAfterCommit: () => Promise<void>;
}

export class CasePropertyRenameStorageConflictError extends Error {
	constructor(
		readonly caseType: string,
		readonly property: string,
		readonly carrier: "case-row" | "parked-value",
	) {
		super(
			`The destination case property "${property}" on "${caseType}" already has saved ${carrier === "case-row" ? "case data" : "parked data"}.`,
		);
		this.name = "CasePropertyRenameStorageConflictError";
	}
}

/**
 * The actor-free slice of the store: schema-change operations are APP-scoped
 * (they apply to every row of an app's case type regardless of which member
 * created it). The instance binds no Project, but each write locks the live app
 * and observes its current Project before schema/case work.
 * `withSchemaContext()` returns this narrow type; callers that only
 * sync schemas (the guarded commit boundary, chat-completion materialize,
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
	 * (`retype` / `narrow-options`); Phase B runs after
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
	 * entries. Call only after the schema state the values were valid
	 * under is restored. An entry whose key meanwhile holds a real
	 * concurrent value is KEPT (reported in `kept`) rather than
	 * clobbered or deleted.
	 */
	unparkValues(args: {
		appId: string;
		ids: ReadonlyArray<string>;
	}): Promise<{ restored: number; kept: number }>;
}

/**
 * Schema store with the explicit caller-transaction seam used only by the
 * guarded Blueprint commit. Keeping this method off `SchemaCaseStore` and
 * `CaseStore` means ordinary consumers and test doubles cannot accidentally
 * depend on transaction composition they do not own.
 */
export interface TransactionalSchemaCaseStore extends SchemaCaseStore {
	/**
	 * Atomically retire case-type schemas inside the guarded Blueprint commit.
	 * Retained case rows are untouched; each schema row becomes inactive at the
	 * commit's sequence and its indexes become durable pending work.
	 */
	retireSchemasPhaseA(
		tx: Transaction<Database>,
		args: ApplyCaseTypeSchemaRetirementArgs,
	): Promise<PreparedCaseTypeSchemaRetirementPhaseB>;

	/**
	 * Converge durable pending expression-index work from the latest stored
	 * schema and deletion tombstones for one app. Safe under duplicate and
	 * out-of-order callers.
	 */
	drainPendingIndexConvergence(args: {
		readonly appId: string;
		readonly caseTypes?: readonly string[];
	}): Promise<void>;

	/**
	 * Force one explicitly named retirement through the empty desired index set,
	 * even if an older application revision already consumed its pending marker.
	 * This is a bounded retirement/deploy repair path, never a routine case-data
	 * operation: inactive lifecycle rows persist forever.
	 */
	drainRetiredIndexConvergence(args: {
		readonly appId: string;
		readonly caseTypes: readonly string[];
	}): Promise<void>;

	/**
	 * Deployment-only global drain. It keeps selecting the durable schema and
	 * deletion work queues until both are empty, and rejects on any DDL or
	 * stored-schema fault so the migration Job fails before traffic shifts.
	 */
	drainAllPendingIndexConvergence(): Promise<void>;

	/**
	 * Apply one explicit, batch-exclusive property-renaming relation.
	 *
	 * Admission and every correctness-bearing write share the caller's app-row
	 * transaction. Every affected live row and parked row is locked and checked
	 * before mutation. An own destination key is occupied even when its JSON
	 * value is null/blank; destinations that are also sources move away
	 * simultaneously. Only `cases.properties` and
	 * `parked_case_values.property` change, so `modified_on`, dismissal state,
	 * reasons, original bytes, and all other columns remain exact.
	 */
	applyCasePropertyRenamePhaseA(
		tx: Transaction<Database>,
		args: ApplyCasePropertyRenameArgs,
	): Promise<PreparedCasePropertyRenamePhaseB>;

	/**
	 * Apply only the transactional schema/data phase on a caller-owned
	 * transaction. The returned concurrent-index completion must run after
	 * `tx` commits successfully.
	 */
	applySchemaChangePhaseA(
		tx: Transaction<Database>,
		args: ApplySchemaChangeArgs,
	): Promise<PreparedSchemaChangePhaseB>;
}

/**
 * The full storage contract every consumer of case DATA binds
 * against — the tenant-bound read/write surface plus the schema
 * operations it inherits from {@link SchemaCaseStore}. Construction
 * is via the `withProjectContext(projectId, actorUserId, ownerId)` factory,
 * which binds the Project the reads/writes scope to, the member who
 * authorizes, and the worker stamped as each new row's `owner_id`.
 */
export interface CaseStore extends SchemaCaseStore {
	/** Read the complete bound worker restore without partitioning through the
	 * active Blueprint catalog. The restore closure and tenant predicates live
	 * in SQL; callers cannot supply case ids or approximate its population. */
	readDeviceCaseDatabase(args: {
		readonly appId: string;
		readonly restoreScope: RestoreScope;
	}): Promise<DeviceCaseDatabase>;

	/** Read the exact tenant-bound rows and outgoing direct indices named by a
	 * committed submission. Preview merges this patch into the device snapshot
	 * captured at form entry, because a local device retains a case it just
	 * closed or reassigned until sync even when a fresh restore would omit it. */
	readCaseDatabasePatch(args: {
		readonly appId: string;
		readonly caseIds: readonly string[];
	}): Promise<DeviceCaseDatabase>;

	/**
	 * Predicate-driven SELECT with optional inline calculated-column
	 * projection. Default ordering (when `sort` is absent) is
	 * `(opened_on, case_id)` ascending — creation time as the durable
	 * ordering fact, with the id purely as a deterministic tie-break.
	 * Case ids are opaque text and carry no time order.
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
	 * Predicate- or owner-driven `COUNT(*)`, always scoped to the bound
	 * Project. The case-type arm returns the row population the
	 * `(appId, caseType, predicate?)` triple resolves to. The case-list
	 * authoring surface's Filters
	 * section uses this to render a "N cases pass this filter"
	 * counter without paying for a full `query` round-trip — the
	 * predicate compiles through the same `compilePredicate` stack
	 * as `query`, so the WHERE clause is identical to the predicate-
	 * narrowed `query` it pairs with.
	 *
	 * Predicate-free case-type callers (the "no filter applied" preview state)
	 * pass `predicate: undefined`; the underlying SELECT collapses
	 * to a tenant-scoped count over the case-type partition.
	 *
	 * The owner arm counts every retained row for `(appId, ownerId)`
	 * across current and retired case types. It is the exact population
	 * persona removal reports and requires no case-type schema.
	 */
	count(args: CountArgs): Promise<number>;

	/**
	 * One page of a case list clustered by a case index, ordered and
	 * windowed the way the device does it.
	 *
	 * The order of operations is the whole contract, and it is the
	 * runtime's:
	 * `commcare-core/.../util/screen/EntityScreenHelper::initEntities`
	 * filters, then sorts, then calls `::groupEntities` — which assigns
	 * each distinct key an ordinal equal to the map size at first
	 * insertion and stably re-sorts on it, so groups follow
	 * FIRST-APPEARANCE order under the user's sort and members keep their
	 * post-sort order within a group. Only then does
	 * `formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
	 * page, counting group boundaries on adjacent keys.
	 *
	 * That is why grouping cannot be applied to an already-fetched page:
	 * a group's membership is a fact about the whole matching set, not
	 * about fifty rows of it.
	 */
	queryGrouped(args: GroupedQueryArgs): Promise<GroupedQueryResult>;

	/**
	 * Insert one case row. Validates `properties` against the
	 * case-type's JSON Schema before the row hits Postgres; derives
	 * the `case_indices` parent edge in the same transaction.
	 * Returns the generated `case_id`.
	 */
	insert(args: {
		appId: string;
		row: CaseInsert;
		/** Relationship for a supplied `parent_case_id`; ordinary child when omitted. */
		parentRelationship?: "child" | "extension";
	}): Promise<{
		caseId: string;
	}>;

	/**
	 * Apply one whole form submission — the ordinary form action
	 * (registration primary + children, followup update + children,
	 * close including final writes) plus the advanced case-operation
	 * program — in ONE Postgres transaction under the store's standard
	 * lock order and in-transaction reauthorization. Operation
	 * expressions evaluate through the AST→Kysely compiler against the
	 * pre-submission snapshot before any DML; targets resolve
	 * server-side (`new` mints or derives its identity, `op` reads the
	 * transaction's allocation record, `session` uses the loaded case,
	 * `expression` reauthorizes through
	 * `validateCaseOperationTargetDescriptor`); the resolved physical
	 * sequence re-proves rolling type safety with
	 * `validateResolvedCaseOperationTypeSequence` before the first
	 * write. Any failure rolls the entire submission back —
	 * `SubmissionRejectedError` for operation-contract rejections, the
	 * standard typed errors otherwise. Partial success is
	 * unobservable.
	 */
	applySubmission(args: ApplySubmissionArgs): Promise<SubmissionEnvelopeResult>;

	/**
	 * Update a case row. JSONB-merges the patch into `properties`,
	 * re-validates against the schema, stamps `modified_on = now()`,
	 * re-derives `case_indices` if `parent_case_id` changed. Throws
	 * `CaseNotFoundError` when the bound Project cannot see the row.
	 */
	update(args: CaseUpdateArgs): Promise<void>;

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
 *   - Implicit standard entries stay out; an explicitly declared standard
 *     entry remains for authoring metadata and order. Standard-name references
 *     resolve through
 *     `sql/dataTypeTokens.ts::RESERVED_SCALAR_COLUMN_BY_PROPERTY` onto their
 *     scalar columns before the map is consulted. The JSON-schema and index
 *     projections separately exclude every scalar-backed name, so retaining
 *     the catalog entry cannot create a duplicate JSONB value or dead index.
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
	// The worker's own case joins the catalog HERE and nowhere above. It is a
	// storable case type but not an authorable one: no module lists it, no form
	// creates one, and no picker offers it, so it stays out of
	// `effectiveCaseTypes` and enters at the storage boundary, which is exactly
	// the set of callers that must resolve a `commcare-user` property's type to
	// read or write a row. `lib/domain/usercase.ts` is why it looks the way it
	// does.
	map.set(USERCASE_CASE_TYPE, usercaseCaseType(blueprint));
	return map;
}
