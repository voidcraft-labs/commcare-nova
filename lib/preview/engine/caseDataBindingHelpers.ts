// lib/preview/engine/caseDataBindingHelpers.ts
//
// Server-only I/O helpers the running-app view's data binding wraps
// in Server Actions. Each helper accepts a `CaseStore` parameter so
// tests inject a per-test store directly, while production wraps
// with `withOwnerContext` at the request boundary in
// `./caseDataBinding.ts`. Splitting from the Server Action module
// is required — Next.js's `"use server"` boundary forbids
// non-action exports in the same module.
//
// Helpers return `CaseRow` directly so consumers read the JSONB
// `properties` document the same way `applySchemaChange` and the
// predicate compiler do. The only coercion is `caseRowToFormPreload`
// at the form-engine boundary, which lives in
// `./caseDataBindingPure.ts` because it's a pure transformation
// over `CaseRow` with no `CaseStore` dependency.
//
// Pure projections + typed-error mappers live in
// `./caseDataBindingPure.ts` so client components can value-import
// them without dragging the case-store's Cloud SQL connector graph
// into their bundle. The `"use server"` action layer composes both
// modules.

import "server-only";

import {
	buildCaseTypeMap,
	type CaseInsert,
	type CaseStore,
	type SortKey as CaseStoreSortKey,
	CaseTypeNotInBlueprintError,
	type CaseUpdate,
} from "@/lib/case-store";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseType,
	Column,
} from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/predicate/builders";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
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

/**
 * Default row count for `populateSampleCasesAction`. Spec § sample
 * data pins 30. Exported so tests using `seedSampleCases`
 * directly match production.
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
 * `caseListConfig` + `blueprint` are both optional: callers without
 * a config (registration forms loading raw rows for inspection)
 * pass neither and receive rows with empty `calculated: {}` maps;
 * callers with a config thread the columns + filter + sort into
 * the single `store.query(...)` call. `caseTypeSchemas` flows from
 * the supplied `blueprint` so predicate / sort / calculated-column
 * compilation resolves typed property reads.
 */
export async function readCases(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		blueprint?: BlueprintDoc;
		caseListConfig?: CaseListConfig;
	},
): Promise<LoadCasesResult> {
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: buildCaseTypeMap(args.blueprint),
		predicate: args.caseListConfig?.filter,
		sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
		calculated: args.caseListConfig?.columns.filter(
			(col) => col.kind === "calculated",
		),
	});
	if (rows.length === 0) return { kind: "empty" };
	return { kind: "rows", rows };
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
 * The v2 `caseListConfig` collapses display, sort, calc, and
 * visibility onto a single `columns` array — calc-arm columns are
 * the calculated projection; per-column `sort` directives surface
 * via `buildCaseStoreSortKeys`; the optional `filter` slot threads
 * through verbatim. A host mounting both the Display section and
 * the Filters section gets predicate narrowing for free; the
 * Display-section preview alone passes the same config through and
 * the underlying query falls through unfiltered when `filter` is
 * undefined.
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
		blueprint: BlueprintDoc;
		caseListConfig: CaseListConfig;
		limit?: number;
	},
): Promise<LoadCaseListPreviewResult> {
	const limit = args.limit ?? PREVIEW_CASE_DEFAULT_LIMIT;
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: buildCaseTypeMap(args.blueprint),
		calculated: args.caseListConfig.columns.filter(
			(col) => col.kind === "calculated",
		),
		predicate: args.caseListConfig.filter,
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
		blueprint: BlueprintDoc;
		caseListConfig: CaseListConfig;
		limit?: number;
	},
): Promise<LoadFilterPreviewResult> {
	const limit = args.limit ?? FILTER_PREVIEW_DEFAULT_LIMIT;

	// Build the schema map once — both reads share the same
	// `caseTypeSchemas` value so the predicate compilation is
	// guaranteed to resolve property data types identically.
	const caseTypeSchemas = buildCaseTypeMap(args.blueprint);

	// Row sample. The filter-section preview is a "results that pass
	// the filter" view, so the predicate slot is the load-bearing
	// arg here — `caseListConfig.filter` flows through verbatim. The
	// calc-arm projection mirrors the Display preview's shape so
	// table cells render uniformly.
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas,
		calculated: args.caseListConfig.columns.filter(
			(col) => col.kind === "calculated",
		),
		predicate: args.caseListConfig.filter,
		sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
		limit,
	});

	// Count of all matching rows. The same predicate compiles
	// through the same `compilePredicate` stack — the count and
	// the row sample are guaranteed to use the identical WHERE
	// clause.
	const totalCount = await store.count({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas,
		predicate: args.caseListConfig.filter,
	});

	return { kind: "rows", rows, totalCount };
}

/**
 * Build the case-store `SortKey[]` array from a v2 `CaseListConfig`.
 * Sort directives in the v2 schema live on each column directly via
 * the optional `column.sort: { direction, priority }` slot — there
 * is no top-level `sort` array. Columns with `sort` set become
 * directives; the array sorts by `priority` ascending with explicit
 * tie-break to source-array index so the column appearing earlier
 * in `caseListConfig.columns` wins on equal priority. The tie-break
 * rule binds at every layer (saga / preview / wire) — see
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
 * Resolves the `CaseType` from the supplied blueprint at the
 * boundary; the case-store's `generateSampleData` reads from the
 * definition directly (property declarations, optional
 * `parent_type`). A blueprint that omits the requested case type
 * surfaces as `CaseTypeNotInBlueprintError`, mapped by the catch
 * block in the calling action.
 */
export async function seedSampleCases(
	store: CaseStore,
	args: { appId: string; caseType: string; blueprint: BlueprintDoc },
): Promise<PopulateSampleCasesResult> {
	const caseType = resolveCaseTypeOrThrow(
		args.blueprint,
		args.appId,
		args.caseType,
	);
	const result = await store.generateSampleData({
		appId: args.appId,
		caseType,
		count: SAMPLE_CASE_DEFAULT_COUNT,
		seed: `${Date.now()}`,
	});
	return { kind: "ok", inserted: result.inserted };
}

/**
 * Look up a `CaseType` definition by name in the supplied blueprint.
 * Throws `CaseTypeNotInBlueprintError` when the case type is absent
 * — same shape as the case-store's `applySchemaChange` throw, so
 * the typed-error mapper at the action boundary handles both
 * uniformly.
 */
function resolveCaseTypeOrThrow(
	blueprint: BlueprintDoc,
	appId: string,
	caseTypeName: string,
): CaseType {
	const found = blueprint.caseTypes?.find((c) => c.name === caseTypeName);
	if (!found) {
		throw new CaseTypeNotInBlueprintError(appId, caseTypeName);
	}
	return found;
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
