// lib/preview/engine/caseDataBindingHelpers.ts
//
// Server-only I/O helpers the running-app view's data binding wraps
// in Server Actions. Each helper accepts a `CaseStore` parameter so
// tests inject a per-test store directly, while production binds one at
// the request boundary via `gatedCaseStore` (the membership-gated
// `withProjectContext` constructor in this module) from
// `./caseDataBinding.ts`. Splitting from the Server Action module is
// required — Next.js's `"use server"` boundary forbids non-action
// exports in the same module.
//
// Helpers return `CaseRow` directly so consumers read the JSONB
// `properties` document the same way `applySchemaChange` and the
// predicate compiler do. The only coercion is `caseRowToFormPreload`
// at the form-engine boundary, which lives in
// `./caseDataBindingClient.ts` — the client-bundle-safe mirror of
// this module — because it has no `CaseStore` dependency.
//
// Doc-store projections + typed-error mappers live in
// `./caseDataBindingClient.ts` so client components can
// value-import them without dragging the case-store's Cloud SQL
// connector graph into their bundle. The `"use server"` action
// layer composes both modules.

import "server-only";

import type { AppCapability } from "@/lib/auth/projectRoles";
import type {
	CaseInsert,
	CaseStore,
	SortKey as CaseStoreSortKey,
	CaseUpdate,
} from "@/lib/case-store";
import { withProjectContext } from "@/lib/case-store";
import {
	CasePropertiesValidationError,
	SchemaNotSyncedError,
} from "@/lib/case-store/errors";
import { resolveAppScope } from "@/lib/db/appAccess";
import { loadApp } from "@/lib/db/apps";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import type { CaseListConfig, CaseType, Column } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { and, eq, literal, prop, term } from "@/lib/domain/predicate/builders";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import { effectiveFilterForEmission } from "@/lib/domain/predicate/simplify";
import { log } from "@/lib/logger";
import type {
	JsonObject,
	LoadCaseDataResult,
	LoadCaseListPreviewResult,
	LoadCasesResult,
	LoadFilterPreviewResult,
	PopulateSampleCasesResult,
	SubmissionMutation,
	SubmissionResult,
} from "./caseDataBindingTypes";
import {
	composeRuntimeFilter,
	type SearchInputValues,
} from "./runtimeBindings";

/**
 * Default row count for `populateSampleCasesAction`. 30 rows is
 * enough to fill the running-app list with variety without making
 * the bulk-insert noticeable. Exported so tests using
 * `seedSampleCases` directly match production.
 */
export const SAMPLE_CASE_DEFAULT_COUNT = 30;

/**
 * Read every row of a case type for the bound tenant, projecting
 * each `caseListConfig.columns` calc-arm column's expression as a
 * SELECT slot. `empty` surfaces the "Generate sample data"
 * affordance.
 *
 * The running-app case-list shows the live module's
 * `caseListConfig.columns`, including `kind: "calculated"` columns.
 * Per the case-store contract calc values are SQL-projected once
 * per row, keyed by `column.uuid`, and surface on
 * `row.calculated[uuid]` — the running-app preview reads the slot
 * directly through `evaluateColumnValue`. No AST evaluator runs on
 * the JS side.
 *
 * `caseListConfig` + `caseTypeSchemas` are both optional: callers
 * without a config (registration forms loading raw rows for
 * inspection) pass neither and receive rows with empty
 * `calculated: {}` maps; callers with a config thread the columns
 * + filter + sort into the single `store.query(...)` call.
 * `caseTypeSchemas` is the case-store's actual schema-resolution
 * dependency — the term compiler reads each `prop` term's
 * `data_type` from the map to pick the column cast — so the helper
 * accepts the narrow shape directly. The Server Action at
 * `./caseDataBinding.ts` does the `BlueprintDoc → ReadonlyMap`
 * conversion once at the request edge via `buildCaseTypeMap`.
 *
 * `inputValues` carries the running-app surface's per-search-input
 * typed values. `composeQueryPredicate` AND-composes the runtime
 * contribution with `caseListConfig.filter` into the single predicate
 * that flows to `store.query(...)`. The per-arm dispatch (simple-arm
 * modes, advanced-arm substitution, range, multi-select-contains)
 * lives in `composeRuntimeFilter` in `./runtimeBindings.ts`.
 */
export async function readCases(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		caseTypeSchemas?: ReadonlyMap<string, CaseType>;
		caseListConfig?: CaseListConfig;
		inputValues?: SearchInputValues;
	},
): Promise<LoadCasesResult> {
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		predicate: composeQueryPredicate(
			args.caseListConfig,
			args.inputValues,
			args.caseType,
		),
		sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
		calculated: args.caseListConfig?.columns.filter(
			(col) => col.kind === "calculated",
		),
	});
	if (rows.length === 0) return { kind: "empty" };
	return { kind: "rows", rows };
}

/**
 * Compose the predicate that flows to `store.query(...)` from the
 * always-on `caseListConfig.filter` slot and the per-input runtime
 * contributions. The two sources collapse into one predicate so the
 * case-store sees a single WHERE clause regardless of how many
 * surfaces contributed.
 *
 * Short-circuit policy:
 *
 *   - `caseListConfig === undefined` — the raw-row read path. No
 *     filter, no inputs; return `undefined` and the case-store falls
 *     through to the unfiltered scan.
 *   - `caseListConfig.searchInputs.length === 0` OR `inputValues`
 *     absent — no runtime contribution. Just the base filter (the
 *     Filters / Display previews and the calc surface call `readCases`
 *     without `inputValues`, so this is the branch they take).
 *   - Both slots populated — AND the base filter with the runtime
 *     filter.
 *
 * Either way the result runs through `effectiveFilterForEmission`, so a
 * `match-all` — top-level OR nested inside an authored `and` — folds to
 * `undefined` (the case-store falls through to the unfiltered scan)
 * rather than pushing a redundant `TRUE` operand into the SQL. This is
 * the same "match-all ≡ no filter" decision the wire emitters apply, so
 * preview and export agree on the effective filter.
 */
function composeQueryPredicate(
	caseListConfig: CaseListConfig | undefined,
	inputValues: SearchInputValues | undefined,
	caseType: string,
): Predicate | undefined {
	if (caseListConfig === undefined) return undefined;
	const baseFilter = caseListConfig.filter;
	if (inputValues === undefined || caseListConfig.searchInputs.length === 0) {
		return effectiveFilterForEmission(baseFilter);
	}

	const runtimeFilter = composeRuntimeFilter(
		caseListConfig.searchInputs,
		inputValues,
		caseType,
	);

	// At most two contributing predicates (base + runtime); AND them
	// when both are present, then normalize.
	const composed =
		baseFilter === undefined ? runtimeFilter : and(baseFilter, runtimeFilter);
	return effectiveFilterForEmission(composed);
}

/**
 * Default row count for the case-list authoring surface's live
 * preview. The preview is a "what does my list look like?" check
 * — it doesn't need to render every row, but it does need enough
 * to communicate the case-list's authored shape (sort order,
 * filter narrowing, calculated-column values per row). 30 mirrors
 * `SAMPLE_CASE_DEFAULT_COUNT` from the sample-data populate path
 * so the two surfaces feel cohesive when the user populates and
 * then previews.
 */
export const PREVIEW_CASE_DEFAULT_LIMIT = 30;

/**
 * Read case-list authoring-surface live-preview rows for the bound
 * tenant. Threads each `kind: "calculated"` column's expression
 * into `store.query` so it evaluates at the SQL layer rather than
 * reconstructed in TypeScript.
 *
 * `caseListConfig` collapses display, sort, calc, and visibility
 * onto a single `columns` array — calc-arm columns are the
 * calculated projection; per-column `sort` directives surface via
 * `buildCaseStoreSortKeys`; the optional `filter` slot threads
 * through verbatim. A host mounting both the Display section and
 * the Filters section gets predicate narrowing for free; the
 * Display-section preview alone passes the same config through
 * and the underlying query falls through unfiltered when `filter`
 * is undefined.
 *
 * `caseTypeSchemas` is the term compiler's data-type-resolution
 * dependency — the helper accepts the narrow shape directly so the
 * Server Action at `./caseDataBinding.ts` runs the
 * `BlueprintDoc → ReadonlyMap` conversion once at the request edge
 * via `buildCaseTypeMap`.
 *
 * Typed-error mapping mirrors `mapPopulateSampleCasesError` for
 * consistency: missing-case-type and schema-not-synced get
 * dedicated arms so the client surface can re-resolve / await the
 * sync rather than render a wrapped invariant message.
 */
export async function readCaseListPreview(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		caseTypeSchemas: ReadonlyMap<string, CaseType>;
		caseListConfig: CaseListConfig;
		limit?: number;
	},
): Promise<LoadCaseListPreviewResult> {
	const limit = args.limit ?? PREVIEW_CASE_DEFAULT_LIMIT;
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		calculated: args.caseListConfig.columns.filter(
			(col) => col.kind === "calculated",
		),
		// Normalize so a `match-all`-reducing filter falls through to the
		// unfiltered scan instead of a redundant `TRUE` operand — same
		// "no effective filter" decision the wire emitters + `readCases`
		// apply, so every preview surface agrees on the effective filter.
		predicate: effectiveFilterForEmission(args.caseListConfig.filter),
		sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
		limit,
	});
	if (rows.length === 0) return { kind: "empty" };
	return { kind: "rows", rows };
}

/**
 * Default row-sample limit for the Filters-section live preview.
 * Smaller than `PREVIEW_CASE_DEFAULT_LIMIT` because the Filters
 * section's preview is "what passes the filter, plus how many" —
 * the count surfaces totality, the row sample only needs to be
 * enough to show shape (column-rendering, sort order). Pinning to
 * 10 mirrors common "top results" UX conventions and keeps the
 * preview's payload bounded even for huge case populations.
 */
export const FILTER_PREVIEW_DEFAULT_LIMIT = 10;

/**
 * Read Filters-section authoring-surface live-preview rows + the
 * full matching count. Threads calc-arm columns into `store.query`
 * for the row sample (so calculated columns evaluate inline at the
 * SQL layer) and pairs with `store.count` for the totality figure
 * — both compile the same predicate through the same stack so the
 * count + row-list pair is internally consistent.
 *
 * The two SELECTs run sequentially (no transaction needed for an
 * authoring-time preview): rows first (cheap, limited) then count
 * second. Concurrent inserts between the two reads can shift the
 * count vs the visible row sample by ±1 row; the preview is
 * tolerant of small drift because it's an authoring hint, not a
 * transactional read.
 *
 * Single `rows` arm covers both the populated and empty success
 * paths — `rows.length === 0` + `totalCount` from the count query
 * is honest under the rare race where a matching row is deleted
 * between the row read and the count read. The renderer formats
 * the empty-rows case from the same arm. A separate `empty` arm
 * would have to hardcode `totalCount: 0`, fighting the racy count.
 *
 * `caseTypeSchemas` flows in pre-built so both the row read and
 * the count read share one value — the predicate compilation is
 * guaranteed to resolve property data types identically across the
 * pair. The Server Action at `./caseDataBinding.ts` runs the
 * `BlueprintDoc → ReadonlyMap` conversion once at the request edge
 * via `buildCaseTypeMap`.
 *
 * Typed-error mapping reuses the same shape as
 * `mapCaseListPreviewError` — `LoadFilterPreviewResult`'s error
 * arms mirror `LoadCaseListPreviewResult`'s, so the mapper logic
 * is identical.
 */
export async function readFilterPreview(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		caseTypeSchemas: ReadonlyMap<string, CaseType>;
		caseListConfig: CaseListConfig;
		limit?: number;
	},
): Promise<LoadFilterPreviewResult> {
	const limit = args.limit ?? FILTER_PREVIEW_DEFAULT_LIMIT;

	// The filter-section preview is a "results that pass the filter"
	// view, so the predicate is the load-bearing arg. Normalize ONCE
	// (the shared "no effective filter" decision: a `match-all`-reducing
	// filter falls through to the unfiltered scan) and reuse it for both
	// the row sample and the count, so the two SELECTs are guaranteed to
	// compile the identical WHERE clause.
	const predicate = effectiveFilterForEmission(args.caseListConfig.filter);

	// Row sample. The calc-arm projection mirrors the Display preview's
	// shape so table cells render uniformly.
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		calculated: args.caseListConfig.columns.filter(
			(col) => col.kind === "calculated",
		),
		predicate,
		sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
		limit,
	});

	// Count of all matching rows, through the same `compilePredicate`
	// stack with the same predicate.
	const totalCount = await store.count({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		predicate,
	});

	return { kind: "rows", rows, totalCount };
}

/**
 * Build the case-store `SortKey[]` array from a `CaseListConfig`.
 * Sort directives live on each column directly via the optional
 * `column.sort: { direction, priority }` slot — there is no
 * top-level `sort` array. Columns with `sort` set become
 * directives; the array sorts by `priority` ascending with
 * explicit tie-break to source-array index so the column
 * appearing earlier in `caseListConfig.columns` wins on equal
 * priority. The tie-break rule binds at every layer (saga /
 * preview / wire) — see
 * `lib/commcare/suite/case-list/sortKeys.ts::buildSortDirectives`,
 * which the wire emitter binds to the same shape.
 *
 * Each survivor's expression lifts based on column kind:
 *   - non-calc kinds → `term(prop(caseType, column.field))`. The
 *     case-store's term compiler resolves `data_type` from the
 *     supplied blueprint's case-type schema and emits the typed
 *     JSONB read; ORDER BY then applies the comparator the
 *     case-store's `SortKey.direction` selects.
 *   - calc kind → the column's `expression` verbatim. Postgres's
 *     planner CSE-folds the redundant evaluation across SELECT +
 *     ORDER BY against identical expressions, so the runtime cost
 *     is one evaluation per row.
 *
 * `caseListConfig === undefined` (the running-app raw-rows path)
 * returns an empty array — the caller's downstream `query` call
 * falls through to the case-store's default insertion order.
 */
function buildCaseStoreSortKeys(
	caseListConfig: CaseListConfig | undefined,
	caseType: string,
): CaseStoreSortKey[] {
	if (caseListConfig === undefined) return [];

	type Survivor = { readonly column: Column; readonly index: number };
	const survivors: Survivor[] = [];
	for (let i = 0; i < caseListConfig.columns.length; i++) {
		const column = caseListConfig.columns[i];
		if (column.sort === undefined) continue;
		survivors.push({ column, index: i });
	}
	if (survivors.length === 0) return [];

	const sorted = [...survivors].sort((a, b) => {
		const ap = a.column.sort?.priority ?? 0;
		const bp = b.column.sort?.priority ?? 0;
		if (ap !== bp) return ap - bp;
		return a.index - b.index;
	});

	return sorted.flatMap(({ column }) => {
		const sortConfig = column.sort;
		if (sortConfig === undefined) return [];
		// Calc-arm column: the column's own `expression` is the sort
		// key. Non-calc kinds carry a flat `field` slot; the case-
		// store's term compiler reads its data_type from the bound
		// blueprint's case-type schema.
		const expression =
			column.kind === "calculated"
				? column.expression
				: term(prop(caseType, column.field));
		return [{ direction: sortConfig.direction, expression }];
	});
}

/**
 * UUID 8-4-4-4-12. Matches every Postgres-accepted form (v4 / v7
 * / nil). Authored here rather than imported because the only
 * consumer is `readCaseData`'s caller-id validation.
 */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a single case row by id. `missing` covers absent-id,
 * cross-tenant (equivalent under the case-store contract), AND
 * syntactically invalid UUIDs — the running-app view occasionally
 * inherits a stale link from a deleted case, and surfacing
 * malformed ids as missing keeps the upstream flow structural.
 *
 * No `blueprint` is threaded — `case_id` is a reserved scalar
 * column, so the term compiler never resolves a property
 * `data_type`. `limit: 1` is belt-and-suspenders; the PK
 * guarantees at-most-one match.
 */
export async function readCaseData(
	store: CaseStore,
	args: { appId: string; caseType: string; caseId: string },
): Promise<LoadCaseDataResult> {
	// Postgres rejects malformed UUIDs at the parameter cast (the
	// column is `uuid`-typed). The early-return covers the
	// syntactic-invalid arm before the SQL runs.
	if (!UUID_PATTERN.test(args.caseId)) return { kind: "missing" };
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		predicate: eq(prop(args.caseType, "case_id"), literal(args.caseId)),
		limit: 1,
	});
	const found = rows[0];
	if (found === undefined) return { kind: "missing" };
	return { kind: "row", row: found };
}

/**
 * Populate an empty case type with `SAMPLE_CASE_DEFAULT_COUNT`
 * rows. The seed composes from `Date.now()` so back-to-back
 * populates produce different rows; tests needing reproducibility
 * call `CaseStore.generateSampleData` directly with a fixed seed.
 *
 * Accepts the full `CaseType` definition directly — the case-store's
 * `generateSampleData` reads property declarations + optional
 * `parent_type` off the definition. The Server Action at
 * `./caseDataBinding.ts` resolves the `CaseType` out of the
 * supplied `BlueprintDoc` at the request edge and forwards the
 * narrow value here; an unresolved case type surfaces as
 * `CaseTypeNotInBlueprintError` from the action layer, mapped by
 * `mapPopulateSampleCasesError`.
 */
export async function seedSampleCases(
	store: CaseStore,
	args: { appId: string; caseType: CaseType },
): Promise<PopulateSampleCasesResult> {
	const result = await store.generateSampleData({
		appId: args.appId,
		caseType: args.caseType,
		count: SAMPLE_CASE_DEFAULT_COUNT,
		seed: `${Date.now()}`,
	});
	return { kind: "ok", inserted: result.inserted };
}

/**
 * Drop every existing sample row for `(appId, caseType)` and
 * regenerate a fresh `SAMPLE_CASE_DEFAULT_COUNT` population. Mirror
 * of `seedSampleCases` over the case-store's atomic
 * `resetSampleData` method — the delete + regenerate run in one
 * Postgres transaction, so a mid-operation failure rolls back to
 * the pre-call population.
 *
 * `resetSampleData` returns `{ deleted, inserted }`; the
 * `PopulateSampleCasesResult` success arm carries only `inserted`
 * because the user-facing UX names the action "regenerate" rather
 * than "delete then regenerate" — surfacing the deleted count would
 * leak the two-step composition the case-store's atomic contract
 * was designed to hide.
 *
 * The case-store picks a fresh seed at call time (no `seed` arg on
 * `ResetSampleDataArgs`), so the regenerated population differs
 * from the prior one with high probability — what authors expect
 * when iterating on schema + filter changes against fresh sample
 * data.
 */
export async function resetSampleCases(
	store: CaseStore,
	args: { appId: string; caseType: CaseType },
): Promise<PopulateSampleCasesResult> {
	const result = await store.resetSampleData({
		appId: args.appId,
		caseType: args.caseType,
		count: SAMPLE_CASE_DEFAULT_COUNT,
	});
	return { kind: "ok", inserted: result.inserted };
}

// ---------------------------------------------------------------
// Submission-mutation helpers
// ---------------------------------------------------------------
//
// The four `apply*Mutation` helpers consume a `SubmissionMutation`
// arm and dispatch to the `CaseStore`'s matching write method. Each
// helper accepts a `CaseStore` parameter (test-injection pattern,
// same shape as the helpers above). The Server Action in
// `./caseDataBinding.ts` discriminates on `mutation.kind` and routes
// to the matching helper; `mapSubmitFormError` translates the
// case-store's typed errors to typed `SubmissionResult` arms.
//
// Atomicity: registration is atomic via
// `caseStore.insertWithChildren` (primary + every child in one
// Postgres transaction). Followup/close run a primary `update`
// followed by per-child `insert`s; close additionally calls
// `caseStore.close` last. The three writes open separate
// transactions — partial success is observable to the running-app
// view, which re-queries after submission per the
// continuous-validation principle.
//
// `case_id` for the primary registration is left to the case-store
// (its `insertWithChildren` either honors a supplied id or fires
// the `DEFAULT uuidv7()` column default). Child case ids likewise
// flow back from each `insert` / `insertWithChildren` call. No
// helper here generates a UUID.

/**
 * Apply a registration `SubmissionMutation` against the bound
 * store. Construct one `CaseInsert` for the primary plus one per
 * child, then route through `caseStore.insertWithChildren` so the
 * primary + every child land in a single Postgres transaction.
 *
 * The case-store generates the primary's `case_id` and threads it
 * as each child's `parent_case_id` — children must not carry an
 * explicit `parent_case_id`. `status: "open"` is set on every row
 * because the column has no default.
 *
 * `caseName === undefined` on the primary or any child trips a
 * `compilerBugMessage`: `cases.case_name` is `text NOT NULL` and
 * the engine's walker plucks the field whose `id === "case_name"`
 * into the `caseName` slot for every contentful bucket; reaching
 * the throw means the form's field tree omits the name leaf, an
 * upstream blueprint authoring contract violation.
 */
export async function applyRegistrationMutation(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "registration" }>;
		appId: string;
	},
): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	const { mutation, appId } = args;
	if (mutation.primary.caseName === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "preview.caseDataBindingHelpers.applyRegistrationMutation",
				invariant: `registration form for case type \`${mutation.primary.caseType}\` produced no \`case_name\` value`,
				detail:
					"Every registration form must declare a leaf field with `id: \"case_name\"` whose value lands the case's display name in `cases.case_name`. Reaching this throw means the engine's walker emitted a registration mutation whose primary bucket carries no name. Hint: confirm the form's field tree includes a `case_name` leaf bound to the module's case type via `case_property_on`.",
			}),
		);
	}

	const childRows: CaseInsert[] = mutation.children.map((child) => {
		if (child.caseName === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.caseDataBindingHelpers.applyRegistrationMutation",
					invariant: `child-case op for case type \`${child.caseType}\` produced no \`case_name\` value`,
					detail:
						'Every case row carries a top-level `case_name`. A form that creates a child case must include a leaf field with `id: "case_name"` bound to the destination case type via `case_property_on`. Reaching this throw means the form\'s field tree omits the name field for that child type.',
				}),
			);
		}
		return {
			case_type: child.caseType,
			case_name: child.caseName,
			status: "open",
			properties: child.properties,
		};
	});

	const result = await store.insertWithChildren({
		appId,
		primary: {
			case_type: mutation.primary.caseType,
			case_name: mutation.primary.caseName,
			status: "open",
			properties: mutation.primary.properties,
		},
		children: childRows,
	});
	return {
		caseId: result.primaryCaseId,
		childCaseIds: result.childCaseIds,
	};
}

/**
 * Apply a followup `SubmissionMutation`: update the bound case's
 * properties (and optionally `case_name`), then insert each child
 * with `parent_case_id` set to the bound case id (already threaded
 * into `child.parentCaseId` at engine derivation time).
 *
 * Empty-patch short-circuit: when the patch carries neither a
 * `caseName` change nor any `properties` write, skip
 * `caseStore.update` entirely. AJV revalidation + a `modified_on`
 * bump for a no-op patch is wasted work.
 *
 * Three transactions land in sequence (one for the primary update,
 * one per child insert). A failure mid-sequence leaves the
 * already-applied writes in place; the running-app view re-queries
 * on resolve, so the user sees whatever landed.
 */
export async function applyFollowupMutation(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "followup" }>;
		appId: string;
	},
): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	const { mutation, appId } = args;
	await applyPrimaryUpdate(store, { mutation, appId });
	const childCaseIds = await insertChildren(store, {
		appId,
		children: mutation.children,
	});
	return { caseId: mutation.caseId, childCaseIds };
}

/**
 * Apply a close `SubmissionMutation`: same primary update + child
 * inserts as the followup arm, plus a final `caseStore.close` to
 * stamp `closed_on`. Close runs last so the closure timestamp
 * lands after every property write. `caseStore.close` is
 * idempotent on row state — re-closing preserves the original
 * timestamp.
 */
export async function applyCloseMutation(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "close" }>;
		appId: string;
	},
): Promise<{ caseId: string; childCaseIds: ReadonlyArray<string> }> {
	const { mutation, appId } = args;
	await applyPrimaryUpdate(store, { mutation, appId });
	const childCaseIds = await insertChildren(store, {
		appId,
		children: mutation.children,
	});
	await store.close({ appId, caseId: mutation.caseId });
	return { caseId: mutation.caseId, childCaseIds };
}

/**
 * Apply a survey `SubmissionMutation`. Surveys own no case rows;
 * structural no-op. Synchronous because there is no I/O.
 */
export function applySurveyMutation(): Extract<
	SubmissionResult,
	{ kind: "survey" }
> {
	return { kind: "survey" };
}

/**
 * Self-heal a case-store call defeated by a `case_type_schemas` row that
 * no longer mirrors the app's PERSISTED blueprint: re-materialize the
 * blueprint's schemas and run the call once more. Two recoverable shapes:
 *
 *   - `SchemaNotSyncedError` — the row is MISSING. A blueprint writer's
 *     case-store sync never landed (canonical producer: a transient
 *     Postgres failure at an edit run's drain-end materialize — the chat
 *     surface's saves are Firestore-only, so nothing re-attempts the
 *     sync until a case-type-touching commit happens to run the
 *     cross-store saga). Always a sync gap, so always healed.
 *   - `CasePropertiesValidationError` whose failures include an
 *     `additionalProperty` — the row is PRESENT but STALE, built from an
 *     older catalog, and rejected a property added since it last synced.
 *     This is the failure behind "Generated sample data … must NOT have
 *     additional properties": the generator derives its rows from the
 *     live catalog while validation runs against the stale row. ONLY this
 *     drift signature is healed — a type / format / enum failure carries
 *     no `additionalProperty` and is treated as genuine invalid data, so
 *     it surfaces immediately WITHOUT a Firestore read + re-materialize.
 *     (Genuine bad data that happens to be an extra-property write — not
 *     drift — re-fails the retry against the unchanged schema and surfaces
 *     honestly; never masked.)
 *
 * The heal re-materializes the WHOLE persisted blueprint, not just the
 * one failing type: a single partial materialize-failure can leave
 * several types missing/stale, and a multi-type write (a registration
 * creating children of several case types) only recovers in one pass if
 * every stale type is re-synced together. Because the heal now fires only
 * on a rare genuine missing/drift event (the drift gate above), the
 * redundant idempotent UPSERTs for already-synced types are not on any
 * hot path.
 *
 * Limitation: the heal can only fix drift that the PERSISTED blueprint
 * reflects. If the same failure that left the row stale ALSO left
 * Firestore stale (or an in-session edit isn't persisted yet), the
 * re-materialize regenerates the same schema and the retry surfaces the
 * error — correct, since the schema must mirror what is stored.
 *
 * `run` MUST be a single store operation, never a multi-write dispatch —
 * the granularity is the retry-safety argument. Each store method is
 * atomic (one statement or one Postgres transaction) and throws BOTH of
 * these errors before its own write lands (validator acquisition and
 * JSON Schema validation both precede the INSERT/UPDATE, and a throw
 * rolls the transaction back), so the operation that threw is by
 * definition the one that didn't land and re-running just it is
 * idempotent. Re-running a whole followup/close dispatch would re-insert
 * the child rows that already committed in their own transactions.
 * Production code reaches this through `schemaHealingCaseStore`, which
 * holds that granularity by construction.
 *
 * One retry only: a second failure (or a heal that itself fails —
 * Postgres still down, app gone) rethrows the ORIGINAL error so the
 * action's typed `schema-not-synced` / `validation-failure` arm stays
 * the honest backstop.
 */
export async function withSchemaHeal<T>(
	args: { appId: string },
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (err) {
		// Heal only a row that doesn't mirror the persisted blueprint:
		// a MISSING row (always a sync gap), or a STALE row that rejected
		// a newly-added property (`additionalProperty` set — schema
		// drift). A type/format/enum validation failure carries no
		// `additionalProperty` and is genuine invalid data — surface it
		// immediately rather than pay a Firestore read + re-materialize.
		const isMissingRow = err instanceof SchemaNotSyncedError;
		const isStaleRowDrift =
			err instanceof CasePropertiesValidationError &&
			err.failures.some((f) => f.additionalProperty !== undefined);
		if (!isMissingRow && !isStaleRowDrift) {
			throw err;
		}
		try {
			const app = await loadApp(args.appId);
			// No owner/membership re-check here: the Server Action that built
			// this healing store already gated Project membership
			// (`resolveAppScope`), and the re-materialize is app-scoped SCHEMA
			// sync (`case_type_schemas` + indexes, no tenant data), so it
			// exposes nothing even if reached. Absent app → rethrow.
			if (!app) throw err;
			await materializeCaseStoreSchemas({
				appId: args.appId,
				blueprint: app.blueprint,
			});
		} catch (healErr) {
			log.error("[caseDataBinding] schema heal failed", healErr, {
				appId: args.appId,
			});
			throw err;
		}
		return await run();
	}
}

/**
 * The single construction path for a tenant-bound case store inside a
 * case-data Server Action. It does two load-bearing things in one place so no
 * action can forget either:
 *
 *   1. **The IDOR gate.** `resolveAppScope` resolves the app's Project AND
 *      verifies the actor holds `required` on it. The `appId` a Server Action
 *      receives is client-supplied and otherwise unchecked — under owner-scoping
 *      the store's own `owner_id` filter made a foreign `appId` harmless, but the
 *      Project-scoped store trusts its bound `projectId`, so THIS membership
 *      check is what now stops a crafted request from reaching another Project's
 *      case data. A denial throws `AppAccessError`; the caller collapses it to
 *      its typed not-found/`error` arm (never alerted — denial is expected).
 *   2. **The Project binding + schema heal.** Binds `withProjectContext` to the
 *      resolved Project (stamping the actor as `owner_id` on writes) and wraps it
 *      in the per-call schema heal.
 *
 * Read actions pass `"view"`; write actions (sample populate/reset, form submit)
 * pass `"edit"`.
 */
export async function gatedCaseStore(
	appId: string,
	userId: string,
	required: AppCapability,
): Promise<CaseStore> {
	const { projectId } = await resolveAppScope(appId, userId, required);
	return schemaHealingCaseStore(await withProjectContext(projectId, userId), {
		appId,
	});
}

/**
 * A `CaseStore` whose every operation self-heals a missing OR stale
 * `case_type_schemas` row via {@link withSchemaHeal} — the heal lives at
 * the INDIVIDUAL store call, so a multi-write flow (a followup/close
 * submission: primary update, then per-child inserts in separate
 * transactions) resumes from the write that threw instead of re-running
 * writes that already landed. The per-case-type validator acquisition
 * (missing row) or JSON Schema validation (stale row) is what throws,
 * before the failing operation's own write commits, so retrying just
 * that operation is idempotent at exactly this granularity.
 *
 * `applySchemaChange` / `dropSchema` delegate un-healed: they are the
 * schema-row writers themselves (`applySchemaChange` IS the heal's
 * remedy), so a self-heal there would recurse the remedy into itself.
 *
 * Typed as a full `CaseStore` so a new store method fails compilation
 * here until someone decides which side of the heal it belongs on.
 */
export function schemaHealingCaseStore(
	store: CaseStore,
	args: { appId: string },
): CaseStore {
	const heal = <T>(run: () => Promise<T>): Promise<T> =>
		withSchemaHeal(args, run);
	return {
		query: (a) => heal(() => store.query(a)),
		count: (a) => heal(() => store.count(a)),
		insert: (a) => heal(() => store.insert(a)),
		insertWithChildren: (a) => heal(() => store.insertWithChildren(a)),
		update: (a) => heal(() => store.update(a)),
		close: (a) => heal(() => store.close(a)),
		traverse: (a) => heal(() => store.traverse(a)),
		applySchemaChange: (a) => store.applySchemaChange(a),
		dropSchema: (a) => store.dropSchema(a),
		generateSampleData: (a) => heal(() => store.generateSampleData(a)),
		resetSampleData: (a) => heal(() => store.resetSampleData(a)),
	};
}

/**
 * Shared implementation for followup/close primary update so both
 * arms have the same empty-patch skip semantics.
 */
async function applyPrimaryUpdate(
	store: CaseStore,
	args: {
		mutation: Extract<SubmissionMutation, { kind: "followup" | "close" }>;
		appId: string;
	},
): Promise<void> {
	const { mutation, appId } = args;
	const hasPropertyWrites = Object.keys(mutation.patch.properties).length > 0;
	const hasCaseNameWrite = mutation.patch.caseName !== undefined;
	if (!hasPropertyWrites && !hasCaseNameWrite) {
		return;
	}
	const patch: CaseUpdate = {
		...(hasPropertyWrites ? { properties: mutation.patch.properties } : {}),
		...(hasCaseNameWrite ? { case_name: mutation.patch.caseName } : {}),
	};
	await store.update({ appId, caseId: mutation.caseId, patch });
}

/**
 * Insert each child of a followup / close mutation in encounter
 * order. The child's `parentCaseId` (bound at engine derivation
 * time to the followup/close `caseId`) lands as the row's
 * `parent_case_id`. Returns generated ids in input order.
 *
 * `caseName === undefined` trips a `compilerBugMessage` for the
 * same reason as the registration arm — every case row carries a
 * top-level `case_name`.
 */
async function insertChildren(
	store: CaseStore,
	args: {
		appId: string;
		children: ReadonlyArray<{
			caseType: string;
			caseName?: string;
			properties: JsonObject;
			parentCaseId: string;
		}>;
	},
): Promise<ReadonlyArray<string>> {
	const ids: string[] = [];
	for (const child of args.children) {
		if (child.caseName === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.caseDataBindingHelpers.insertChildren",
					invariant: `child-case op for case type \`${child.caseType}\` produced no \`case_name\` value`,
					detail:
						'Every case row carries a top-level `case_name`. A form that creates a child case must include a leaf field with `id: "case_name"` bound to the destination case type via `case_property_on`. Reaching this throw means the form\'s field tree omits the name field for that child type.',
				}),
			);
		}
		const row: CaseInsert = {
			case_type: child.caseType,
			case_name: child.caseName,
			status: "open",
			parent_case_id: child.parentCaseId,
			properties: child.properties,
		};
		const { caseId } = await store.insert({ appId: args.appId, row });
		ids.push(caseId);
	}
	return ids;
}
