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
	CaseRow,
	CaseStore,
	SortKey as CaseStoreSortKey,
	CaseUpdate,
	TermBindings,
} from "@/lib/case-store";
import { withProjectContext } from "@/lib/case-store";
import {
	CasePropertiesValidationError,
	SchemaNotSyncedError,
} from "@/lib/case-store/errors";
import { resolveAppScope } from "@/lib/db/appAccess";
import { loadApp } from "@/lib/db/apps";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { byListColumnOrder } from "@/lib/doc/order/compare";
import {
	type CaseListConfig,
	type CaseType,
	type Column,
	caseListColumnHasRuntimeRole,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import {
	ancestorPath,
	eq,
	isIn,
	isNull,
	literal,
	not,
	or,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate/builders";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import { effectiveFilterForEmission } from "@/lib/domain/predicate/simplify";
import { log } from "@/lib/logger";
import type {
	CaseQueryConstraintSource,
	JsonObject,
	LoadCaseDataResult,
	LoadCasesResult,
	LoadFilterPreviewResult,
	PopulateSampleCasesResult,
	SubmissionMutation,
	SubmissionResult,
} from "./caseDataBindingTypes";
import {
	bindSearchInputValuesInPredicate,
	composeRuntimeFilter,
	type SearchInputValues,
	withSearchInputExpressionValues,
} from "./runtimeBindings";

/**
 * Default row count for `populateSampleCasesAction`. 30 rows is
 * enough to fill the running-app list with variety without making
 * the bulk-insert noticeable. Exported so tests using
 * `seedSampleCases` directly match production.
 */
export const SAMPLE_CASE_DEFAULT_COUNT = 30;

/** Narrow and discard legacy calculated definitions that are neither shown
 * nor used for ordering. Keeping this as a real type predicate lets the
 * case-store receive the calculated-column arm rather than the broad union. */
function isRuntimeCalculatedColumn(
	column: Column,
): column is Extract<Column, { kind: "calculated" }> {
	return column.kind === "calculated" && caseListColumnHasRuntimeRole(column);
}

/**
 * Read an optional bounded window of one case type for the bound tenant,
 * projecting each `caseListConfig.columns` calc-arm column's expression as a
 * SELECT slot. Running Results always supplies a page; raw helper consumers
 * may omit it for their legacy unpaged read. An empty bounded worker query
 * also reports the authored-only population so the UI can name Search versus
 * Cases available as the real cause.
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
 * `excludedOwnerIds` is the already-evaluated advanced search value. It joins
 * that same predicate rather than being post-filtered in JavaScript, so limits,
 * sort order, and empty-state semantics all see the truthful population.
 */
export async function readCases(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		caseTypeSchemas?: ReadonlyMap<string, CaseType>;
		caseListConfig?: CaseListConfig;
		inputValues?: SearchInputValues;
		bindings?: TermBindings;
		excludedOwnerIds?: readonly string[];
		authoredExcludedOwnerIds?: readonly string[];
		page?: { offset: number; limit: number };
	},
): Promise<LoadCasesResult> {
	const composedQuery = composeQueryPredicate(
		args.caseListConfig,
		args.inputValues,
		args.caseType,
		args.caseTypeSchemas,
		args.excludedOwnerIds,
		args.authoredExcludedOwnerIds,
	);
	const page = normalizeCaseListPage(args.page);
	const countArgs = {
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		bindings: args.bindings,
		predicate: composedQuery.predicate,
	};
	let totalCount =
		page === undefined ? undefined : await store.count(countArgs);
	if (page !== undefined && totalCount === 0) {
		const authoredMatchingCount =
			composedQuery.constraintSource === "worker-search"
				? await countAuthoredCasePopulation(store, args)
				: undefined;
		return {
			kind: "empty",
			constraintSource: composedQuery.constraintSource,
			...(authoredMatchingCount !== undefined && { authoredMatchingCount }),
		};
	}
	let pageOffset =
		page === undefined || totalCount === undefined
			? (page?.offset ?? 0)
			: Math.min(
					page.offset,
					Math.floor((totalCount - 1) / page.limit) * page.limit,
				);
	const queryAtOffset = (offset: number) =>
		store.query({
			appId: args.appId,
			caseType: args.caseType,
			caseTypeSchemas: args.caseTypeSchemas,
			bindings: args.bindings,
			predicate: composedQuery.predicate,
			sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
			calculated: args.caseListConfig?.columns.filter(
				isRuntimeCalculatedColumn,
			),
			limit: page?.limit,
			offset: page === undefined ? undefined : offset,
		});
	let rows = await queryAtOffset(pageOffset);

	// COUNT and SELECT are intentionally separate, so a delete can remove the
	// last row from the counted page between them. Recount and reclamp exactly
	// once before calling the population empty: this repairs the common stale
	// final-page race while preserving the caller's normalized limit and cannot
	// spin under a continuously mutating dataset.
	if (
		page !== undefined &&
		totalCount !== undefined &&
		totalCount > 0 &&
		rows.length === 0
	) {
		totalCount = await store.count(countArgs);
		if (totalCount > 0) {
			pageOffset = Math.min(
				page.offset,
				Math.floor((totalCount - 1) / page.limit) * page.limit,
			);
			rows = await queryAtOffset(pageOffset);
		}
	}
	if (rows.length === 0) {
		const authoredMatchingCount =
			composedQuery.constraintSource === "worker-search"
				? await countAuthoredCasePopulation(store, args)
				: undefined;
		return {
			kind: "empty",
			constraintSource: composedQuery.constraintSource,
			...(authoredMatchingCount !== undefined && { authoredMatchingCount }),
		};
	}
	return {
		kind: "rows",
		rows,
		constraintSource: composedQuery.constraintSource,
		...(page !== undefined && {
			totalCount: totalCount ?? rows.length,
			pageOffset,
			pageSize: page.limit,
		}),
	};
}

/** A crafted Server Action payload must not turn a bounded Results read back
 * into an unbounded scan. Fifty is the normal UI page; one hundred leaves room
 * for future denser layouts without making the client the resource authority. */
const CASE_LIST_PAGE_LIMIT_CEILING = 100;

function normalizeCaseListPage(
	page: { readonly offset: number; readonly limit: number } | undefined,
): { readonly offset: number; readonly limit: number } | undefined {
	if (page === undefined) return undefined;
	const limit = Number.isFinite(page.limit)
		? Math.min(
				CASE_LIST_PAGE_LIMIT_CEILING,
				Math.max(1, Math.floor(page.limit)),
			)
		: 1;
	const offset = Number.isFinite(page.offset)
		? Math.max(0, Math.floor(page.offset))
		: 0;
	return { offset, limit };
}

/** Count the population that authored availability alone permits. This is the
 * causal boundary for an empty worker Search: if this is already zero, telling
 * the worker to clear Search is false because no Search answer can reveal a
 * row until the authored rule changes. */
async function countAuthoredCasePopulation(
	store: CaseStore,
	args: {
		readonly appId: string;
		readonly caseType: string;
		readonly caseTypeSchemas?: ReadonlyMap<string, CaseType>;
		readonly caseListConfig?: CaseListConfig;
		readonly bindings?: TermBindings;
		readonly authoredExcludedOwnerIds?: readonly string[];
	},
): Promise<number> {
	const authoredQuery = composeQueryPredicate(
		args.caseListConfig,
		undefined,
		args.caseType,
		args.caseTypeSchemas,
		args.authoredExcludedOwnerIds,
		args.authoredExcludedOwnerIds,
	);
	return store.count({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		bindings: args.bindings,
		predicate: authoredQuery.predicate,
	});
}

/**
 * Compose the predicate that flows to `store.query(...)` from the
 * always-on `caseListConfig.filter` slot, per-input runtime contributions, and
 * the optional excluded-owner set. The sources collapse into one predicate so
 * the case-store sees a single WHERE clause regardless of how many surfaces
 * contributed.
 *
 * Short-circuit policy:
 *
 *   - No config and no excluded owners — the raw-row read path; return
 *     `undefined` and the case-store falls through to the unfiltered scan.
 *   - `caseListConfig.searchInputs.length === 0` OR `inputValues`
 *     absent — no prompt contribution. The base filter and owner exclusion
 *     still apply.
 *   - Multiple populated sources — AND every effective predicate together.
 *
 * Either way the result runs through `effectiveFilterForEmission`, so a
 * `match-all` — top-level OR nested inside an authored `and` — folds to
 * `undefined` (the case-store falls through to the unfiltered scan)
 * rather than pushing a redundant `TRUE` operand into the SQL. This is
 * the same "match-all ≡ no filter" decision the wire emitters apply, so
 * preview and export agree on the effective filter.
 */
interface ComposedCaseQuery {
	readonly predicate: Predicate | undefined;
	readonly constraintSource: CaseQueryConstraintSource;
}

function composeQueryPredicate(
	caseListConfig: CaseListConfig | undefined,
	inputValues: SearchInputValues | undefined,
	caseType: string,
	caseTypeSchemas: ReadonlyMap<string, CaseType> | undefined,
	excludedOwnerIds: readonly string[] | undefined,
	authoredExcludedOwnerIds: readonly string[] | undefined = excludedOwnerIds,
): ComposedCaseQuery {
	const clauses: Predicate[] = [];
	let hasAuthoredConstraint = false;
	let hasWorkerConstraint = false;
	const knownInputNames = new Set(
		caseListConfig?.searchInputs.map((input) => input.name) ?? [],
	);
	const emptyExpressionInputValues =
		caseListConfig === undefined
			? undefined
			: withSearchInputExpressionValues(caseListConfig.searchInputs, new Map());
	const expressionInputValues =
		caseListConfig !== undefined && inputValues !== undefined
			? withSearchInputExpressionValues(
					caseListConfig.searchInputs,
					inputValues,
				)
			: emptyExpressionInputValues;
	const authoredFilter =
		caseListConfig?.filter !== undefined && expressionInputValues !== undefined
			? bindSearchInputValuesInPredicate(
					caseListConfig.filter,
					expressionInputValues,
					knownInputNames,
					caseListConfig.searchInputs,
				)
			: caseListConfig?.filter;
	const baseFilter = effectiveFilterForEmission(authoredFilter);
	if (baseFilter !== undefined) {
		clauses.push(baseFilter);
		const filterWithoutWorkerValues =
			caseListConfig?.filter !== undefined &&
			emptyExpressionInputValues !== undefined
				? bindSearchInputValuesInPredicate(
						caseListConfig.filter,
						emptyExpressionInputValues,
						knownInputNames,
						caseListConfig.searchInputs,
					)
				: caseListConfig?.filter;
		const baseFilterWithoutWorkerValues = effectiveFilterForEmission(
			filterWithoutWorkerValues,
		);
		// Predicate ASTs are canonical JSON-shaped values. A changed effective
		// filter means submitted prompt values added narrowing the worker can
		// remove; the empty-bound remainder is the always-authored contribution.
		hasWorkerConstraint =
			JSON.stringify(baseFilter) !==
			JSON.stringify(baseFilterWithoutWorkerValues);
		hasAuthoredConstraint = baseFilterWithoutWorkerValues !== undefined;
	}

	if (
		caseListConfig !== undefined &&
		inputValues !== undefined &&
		caseListConfig.searchInputs.length > 0
	) {
		const runtimeFilter = effectiveFilterForEmission(
			composeRuntimeFilter(
				caseListConfig.searchInputs,
				inputValues,
				caseType,
				caseTypeSchemas,
			),
		);
		if (runtimeFilter !== undefined) {
			clauses.push(runtimeFilter);
			hasWorkerConstraint = true;
		}
	}

	const normalizeOwnerIds = (ownerIds: readonly string[] | undefined) => [
		...new Set(
			(ownerIds ?? []).map((ownerId) => ownerId.trim()).filter(Boolean),
		),
	];
	const ownerIds = normalizeOwnerIds(excludedOwnerIds);
	const authoredOwnerIds = normalizeOwnerIds(authoredExcludedOwnerIds);
	if (ownerIds.length > 0) {
		hasAuthoredConstraint ||= authoredOwnerIds.length > 0;
		hasWorkerConstraint ||=
			JSON.stringify(ownerIds) !== JSON.stringify(authoredOwnerIds);
		const [firstOwnerId, ...otherOwnerIds] = ownerIds;
		clauses.push(
			or(
				isNull(prop(caseType, "owner_id")),
				not(
					isIn(
						prop(caseType, "owner_id"),
						literal(firstOwnerId),
						...otherOwnerIds.map((ownerId) => literal(ownerId)),
					),
				),
			),
		);
	}
	// A worker value can also REMOVE an authored/default owner exclusion. That
	// loosening cannot itself cause an empty result, but it is still worker-
	// dependent provenance and must not be presented as a fixed availability
	// rule when the authored-only probe explains the population differently.
	if (
		ownerIds.length === 0 &&
		JSON.stringify(ownerIds) !== JSON.stringify(authoredOwnerIds)
	) {
		hasWorkerConstraint = true;
		hasAuthoredConstraint ||= authoredOwnerIds.length > 0;
	}

	const predicate =
		clauses.length === 0
			? undefined
			: clauses.length === 1
				? clauses[0]
				: effectiveFilterForEmission({
						kind: "and",
						clauses: clauses as [Predicate, ...Predicate[]],
					});
	return {
		predicate,
		constraintSource: hasWorkerConstraint
			? "worker-search"
			: hasAuthoredConstraint
				? "authored-rules"
				: "unconstrained",
	};
}

/**
 * Default row-sample limit for the Filters-section live preview.
 * The filter preview is "what passes the filter, plus how many" —
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
 * Missing case types and unsynced schemas are mapped to dedicated
 * result arms at the Server Action boundary.
 */
export async function readFilterPreview(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		caseTypeSchemas: ReadonlyMap<string, CaseType>;
		caseListConfig: CaseListConfig;
		bindings?: TermBindings;
		excludedOwnerIds?: readonly string[];
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
	const predicate = composeQueryPredicate(
		args.caseListConfig,
		undefined,
		args.caseType,
		args.caseTypeSchemas,
		args.excludedOwnerIds,
	).predicate;

	// Row sample. Calculated columns are projected by the case store so
	// callers receive the same row shape as the running case list.
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		bindings: args.bindings,
		calculated: args.caseListConfig.columns.filter(isRuntimeCalculatedColumn),
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
		bindings: args.bindings,
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
 * explicit tie-break to independent Results order so the column
 * appearing earlier in the running list wins on equal priority.
 * Details order cannot affect query ordering. The tie-break rule binds at
 * every layer (saga / preview / wire) — see
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
	const stablePageTieBreaker: CaseStoreSortKey = {
		direction: "asc",
		expression: term(prop(caseType, "case_id")),
	};
	if (caseListConfig === undefined) return [stablePageTieBreaker];

	type Survivor = { readonly column: Column; readonly index: number };
	const survivors: Survivor[] = [];
	// Results order — the same independent surface sequence the short-detail
	// wire emitter walks, so equal-priority sort rules break ties identically
	// without coupling the running list to Details rearrangement.
	const sortedColumns = [...caseListConfig.columns].sort(byListColumnOrder);
	for (let i = 0; i < sortedColumns.length; i++) {
		const column = sortedColumns[i];
		if (column.sort === undefined) continue;
		survivors.push({ column, index: i });
	}
	if (survivors.length === 0) return [stablePageTieBreaker];

	const sorted = [...survivors].sort((a, b) => {
		const ap = a.column.sort?.priority ?? 0;
		const bp = b.column.sort?.priority ?? 0;
		if (ap !== bp) return ap - bp;
		return a.index - b.index;
	});

	return [
		...sorted.flatMap(({ column }) => {
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
		}),
		// Offset pagination needs a total order. Authored keys can tie; UUIDv7
		// case identity is deterministic and preserves insertion order for the
		// otherwise-unsorted list without exposing another setting.
		stablePageTieBreaker,
	];
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
 * The `row` arm also carries the case's ANCESTOR chain
 * (nearest-first: parent, grandparent, …) so the form engine can
 * resolve `#<ancestor_type>/<prop>` references the same way the
 * wire's `…/index/parent × depth …` casedb walk does. The walk is
 * data-driven — one `traverse` per hop off the live `parent_case_id`
 * links — so no blueprint needs threading: the caller supplies just
 * `ancestorDepth`, the form's reachable-chain depth
 * (`reachableCaseTypes(...).length - 1`), which is exactly how many
 * hops any ref on the form can address; which namespaces a form may
 * READ is the validator's `caseRefAcceptMap` concern, decided at
 * authoring time.
 *
 * The optional `caseListConfig` + `caseTypeSchemas` pair enriches only
 * the selected row with the same calculated-column projection Results
 * uses. It deliberately does NOT carry the list filter, search answers,
 * sort, or page window: a canonical Details URL addresses a case by
 * identity even when that case is outside (or excluded from) the current
 * Results page. Raw case-loading-form callers omit the pair and receive
 * the ordinary `calculated: {}` row shape.
 *
 * `case_id` is a reserved scalar column, so the identity predicate itself
 * needs no schema lookup. `limit: 1` is belt-and-suspenders; the PK
 * guarantees at-most-one match.
 */
export async function readCaseData(
	store: CaseStore,
	args: {
		appId: string;
		caseType: string;
		caseId: string;
		ancestorDepth: number;
		caseListConfig?: CaseListConfig;
		caseTypeSchemas?: ReadonlyMap<string, CaseType>;
		bindings?: TermBindings;
	},
): Promise<LoadCaseDataResult> {
	// Postgres rejects malformed UUIDs at the parameter cast (the
	// column is `uuid`-typed). The early-return covers the
	// syntactic-invalid arm before the SQL runs.
	if (!UUID_PATTERN.test(args.caseId)) return { kind: "missing" };
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		bindings: args.bindings,
		predicate: eq(prop(args.caseType, "case_id"), literal(args.caseId)),
		calculated: args.caseListConfig?.columns.filter(isRuntimeCalculatedColumn),
		limit: 1,
	});
	const found = rows[0];
	if (found === undefined) return { kind: "missing" };
	return {
		kind: "row",
		row: found,
		ancestors: await walkAncestors(
			store,
			args.appId,
			found,
			args.ancestorDepth,
		),
	};
}

/**
 * Hard ceiling on the ancestor walk's hop count. `ancestorDepth`
 * arrives from the client (the form's reachable-chain depth), so the
 * clamp bounds the per-hop SELECTs a crafted request could demand.
 * Real CommCare hierarchies run 2–3 levels; a `parent_type` chain
 * anywhere near 64 is pathological authoring, so within the ceiling
 * the walk covers every depth the validator admits.
 */
const ANCESTOR_WALK_DEPTH_CEILING = 64;

/**
 * Walk the anchor's parent chain through the case-store's `parent`
 * index edges, nearest-first, at most `min(depth, ceiling)` hops.
 * Each hop is one `traverse` call (the tenant-scoped way to fetch a
 * row whose case TYPE isn't known up front — `query` requires a
 * case-type partition). The seen-set terminates data-level cycles.
 *
 * The chain is ENRICHMENT: a missing parent row (dangling
 * `parent_case_id`, cross-tenant parent) ends the walk, and a
 * mid-walk throw degrades to the rows already fetched rather than
 * failing a load whose essential row already succeeded — either
 * way the unreached namespaces read blank in the form, the same
 * shape as an unset property.
 */
async function walkAncestors(
	store: CaseStore,
	appId: string,
	anchor: CaseRow,
	depth: number,
): Promise<CaseRow[]> {
	const maxDepth = Number.isFinite(depth)
		? Math.min(Math.max(0, Math.floor(depth)), ANCESTOR_WALK_DEPTH_CEILING)
		: 0;
	const ancestors: CaseRow[] = [];
	const seen = new Set<string>([anchor.case_id]);
	let current = anchor;
	try {
		while (current.parent_case_id !== null && ancestors.length < maxDepth) {
			const parents = await store.traverse({
				appId,
				caseId: current.case_id,
				via: ancestorPath(relationStep("parent")),
			});
			const parent = parents[0];
			if (parent === undefined || seen.has(parent.case_id)) break;
			seen.add(parent.case_id);
			ancestors.push(parent);
			current = parent;
		}
	} catch (err) {
		log.warn("[caseDataBinding] ancestor walk failed mid-chain", {
			appId,
			caseId: anchor.case_id,
			fetched: ancestors.length,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return ancestors;
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
 * atomically stamp `closed_on` and the built-in lifecycle
 * `status = "closed"`. Close runs last so the lifecycle transition
 * lands after every property write. `caseStore.close` is idempotent
 * on consistent row state and repairs the status of a previously
 * inconsistent closed row without replacing its closure timestamp.
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
 *     surface's saves persist only the blueprint doc, so nothing
 *     re-attempts the case-store sync until a case-type-touching commit
 *     happens to run the cross-store saga). Always a sync gap, so always healed.
 *   - `CasePropertiesValidationError` whose failures include an
 *     `additionalProperty` — the row is PRESENT but STALE, built from an
 *     older catalog, and rejected a property added since it last synced.
 *     This is the failure behind "Generated sample data … must NOT have
 *     additional properties": the generator derives its rows from the
 *     live catalog while validation runs against the stale row. ONLY this
 *     drift signature is healed — a type / format / enum failure carries
 *     no `additionalProperty` and is treated as genuine invalid data, so
 *     it surfaces immediately WITHOUT a Postgres read + re-materialize.
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
 * the persisted blueprint stale (or an in-session edit isn't persisted yet), the
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
		// immediately rather than pay a Postgres read + re-materialize.
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
			// `syncedSeq` = `mutation_seq` off the SAME snapshot as the blueprint
			// (never a fresh read) so the two never diverge — the seq the heal
			// records must match exactly what it materialized, or the monotone
			// `synced_seq` gate would pair a later seq with an earlier schema.
			await materializeCaseStoreSchemas({
				appId: args.appId,
				blueprint: app.blueprint,
				syncedSeq: app.mutation_seq,
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
