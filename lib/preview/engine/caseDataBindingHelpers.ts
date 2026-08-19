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

import { createHash } from "node:crypto";
import type { AppCapability } from "@/lib/auth/projectRoles";
import { getSession } from "@/lib/auth-utils";
import type {
	ApplySubmissionArgs,
	CaseOperationProgram,
	CaseRow,
	CaseStore,
	SortKey as CaseStoreSortKey,
	LookupTableSchemas,
	RestoreScope,
	SubmissionReceiptIdentity,
	TermBindings,
} from "@/lib/case-store";
import { buildCaseTypeMap, withProjectContext } from "@/lib/case-store";
import {
	CaptureSubmissionRejectedError,
	CasePropertiesValidationError,
	SchemaNotSyncedError,
} from "@/lib/case-store/errors";
import {
	resolveAppScope,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { loadApp } from "@/lib/db/apps";
import {
	drainPendingCaseSchemaIndexes,
	materializeCaseStoreSchemas,
} from "@/lib/db/materializeCaseStoreSchemas";
import type { AppDoc } from "@/lib/db/types";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import {
	caseOperationConditionalGuardUuids,
	caseOperationExpressionSnapshotTypes,
	caseOperationMultiplicityScopes,
} from "@/lib/doc/caseOperationOrder";
import {
	extractLookupReferenceOccurrences,
	lookupReferenceTargetsFromOccurrences,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import {
	assignedLocationUuids,
	asUuid,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseOperation,
	type CaseTileGrouping,
	type CaseType,
	type Column,
	caseListColumnIsEmitted,
	isCaptureFieldKind,
	orderedCaseOperations,
	orderedColumns,
	organizationLevelsOf,
	ownRecordValue,
	type PersistableDoc,
	personasOf,
	type UserCollections,
	type Uuid,
} from "@/lib/domain";
import {
	CAPTURE_EXTENSIONS_BY_KIND,
	captureContentType,
	committedCapturePath,
} from "@/lib/domain/captureFormats";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { asWalkableDoc } from "@/lib/domain/mediaRefs";
import type { Predicate, Term, ValueExpression } from "@/lib/domain/predicate";
import {
	mapExpressionAst,
	mapPredicateAst,
	walkExpressionTerms,
	walkTerms,
} from "@/lib/domain/predicate";
import {
	ancestorPath,
	eq,
	isBlank,
	isIn,
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
import {
	getLookupDefinitions,
	getLookupFixtureData,
} from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { memberOwnerIds, personaOwnerIds } from "@/lib/organization/ownerSets";
import { readOrganizationTopology } from "@/lib/organization/service";
import type { CaptureSubmissionProjection } from "./captureSubmissionValidation";
import type {
	CaseQueryConstraintSource,
	LoadCaseDataResult,
	LoadCasesResult,
	LoadFilterPreviewResult,
	PopulateSampleCasesResult,
	SubmissionAnswerEntry,
	SubmissionMutation,
} from "./caseDataBindingTypes";
import {
	previewAsMe,
	previewAsPersona,
	type ResolvedPreviewIdentity,
} from "./identity";
import { type PreviewLookupData, previewLookupData } from "./lookupEvaluation";
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

/** Narrow to calculated definitions that the running app executes. A dormant
 * saved calculation remains fully valid but contributes no query projection.
 * Keeping this as a real type predicate lets the case-store receive the
 * calculated-column arm rather than the broad union. */
function isRuntimeCalculatedColumn(
	column: Column,
): column is Extract<Column, { kind: "calculated" }> {
	return column.kind === "calculated" && caseListColumnIsEmitted(column);
}

/**
 * Read an optional bounded window of one case type for the bound tenant,
 * projecting each `caseListConfig.columns` calc-arm column's expression as a
 * SELECT slot. Running Results always supplies a page; the current form
 * auto-selection consumer omits it for a complete candidate read. An empty bounded worker query
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
		/** Rows-free lookup definition types for the compiler's
		 * `table-lookup`/`table-column` arms — required whenever the
		 * composed predicate / calc columns carry a lookup carrier
		 * (`collectConfigLookupTableIds` + `loadLookupTableSchemas`
		 * derive it at the action boundary). */
		lookupTableSchemas?: LookupTableSchemas;
		excludedOwnerIds?: readonly string[];
		authoredExcludedOwnerIds?: readonly string[];
		page?: { offset: number; limit: number };
		/**
		 * Read as this worker's device would. Passed by the RUNNING preview and
		 * by nothing else — the case workspace and the sample-data surfaces read
		 * the tenant, because neither is standing at a device.
		 */
		restoreScope?: RestoreScope;
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
	// Grouping is a property of a BOUNDED running-list read. An unpaged
	// caller (the form auto-selection candidate read) wants the complete
	// candidate set and has no list to draw, so it stays on the flat path
	// even when the module's tile is grouped.
	const grouping =
		page === undefined ? undefined : args.caseListConfig?.tile?.grouping;
	if (grouping !== undefined && page !== undefined) {
		return readGroupedCases(store, args, composedQuery, page, grouping);
	}
	const countArgs = {
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		bindings: args.bindings,
		lookupTableSchemas: args.lookupTableSchemas,
		predicate: composedQuery.predicate,
		restoreScope: args.restoreScope,
	};
	/**
	 * How many cases the SAME authored query matches across the tenant, minus
	 * what the device holds. One extra count, run only when a restore is bound
	 * and only for a paged (running-list) read, so the authoring-only reveal
	 * can say what it is hiding instead of leaving an author to wonder why
	 * their data vanished.
	 */
	const outsideRestoreCount = async (
		restricted: number,
	): Promise<number | undefined> => {
		if (args.restoreScope === undefined) return undefined;
		const everything = await store.count({
			...countArgs,
			restoreScope: undefined,
		});
		const outside = everything - restricted;
		return outside > 0 ? outside : undefined;
	};
	let totalCount =
		page === undefined ? undefined : await store.count(countArgs);
	if (page !== undefined && totalCount === 0) {
		const authoredMatchingCount =
			composedQuery.constraintSource === "worker-search"
				? await countAuthoredCasePopulation(store, args)
				: undefined;
		const outside = await outsideRestoreCount(0);
		return {
			kind: "empty",
			constraintSource: composedQuery.constraintSource,
			...(authoredMatchingCount !== undefined && { authoredMatchingCount }),
			...(outside !== undefined && { outsideRestoreCount: outside }),
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
			lookupTableSchemas: args.lookupTableSchemas,
			predicate: composedQuery.predicate,
			sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
			calculated: args.caseListConfig?.columns.filter(
				isRuntimeCalculatedColumn,
			),
			limit: page?.limit,
			offset: page === undefined ? undefined : offset,
			restoreScope: args.restoreScope,
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
		const outside = await outsideRestoreCount(totalCount ?? 0);
		return {
			kind: "empty",
			constraintSource: composedQuery.constraintSource,
			...(authoredMatchingCount !== undefined && { authoredMatchingCount }),
			...(outside !== undefined && { outsideRestoreCount: outside }),
		};
	}
	const outside =
		page === undefined
			? undefined
			: await outsideRestoreCount(totalCount ?? rows.length);
	return {
		kind: "rows",
		rows,
		constraintSource: composedQuery.constraintSource,
		...(page !== undefined && {
			totalCount: totalCount ?? rows.length,
			pageOffset,
			pageSize: page.limit,
		}),
		...(outside !== undefined && { outsideRestoreCount: outside }),
	};
}

/**
 * The grouped twin of `readCases`' bounded path: one `store.queryGrouped`
 * whose window counts GROUPS, so a page holds whole groups and however many
 * cases those groups happen to carry. That row-unboundedness is the
 * platform's own behaviour
 * (`formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
 * pages on group boundaries), so the preview reproduces it rather than
 * re-clamping to a row budget no device applies.
 *
 * `rows` still carries the flat page in clustered order, so every consumer
 * that reads rows — selection, the persistent tile, the empty-state copy —
 * keeps working unchanged; `grouped` adds the clustering the tile renderer
 * draws from.
 *
 * The reclamp mirrors `readCases`' stale-final-page repair, once and only
 * once, but needs no recount: `totalGroups` comes from the same statement as
 * the page, so the pager's denominator and the page can never disagree.
 */
async function readGroupedCases(
	store: CaseStore,
	args: Parameters<typeof readCases>[1],
	composedQuery: ComposedCaseQuery,
	page: { readonly offset: number; readonly limit: number },
	grouping: CaseTileGrouping,
): Promise<LoadCasesResult> {
	const queryAtOffset = (groupOffset: number) =>
		store.queryGrouped({
			appId: args.appId,
			caseType: args.caseType,
			caseTypeSchemas: args.caseTypeSchemas,
			bindings: args.bindings,
			lookupTableSchemas: args.lookupTableSchemas,
			predicate: composedQuery.predicate,
			sort: buildCaseStoreSortKeys(args.caseListConfig, args.caseType),
			calculated: args.caseListConfig?.columns.filter(
				isRuntimeCalculatedColumn,
			),
			indexIdentifier: grouping.identifier,
			groupOffset,
			groupLimit: page.limit,
		});

	let pageOffset = page.offset;
	let result = await queryAtOffset(pageOffset);
	if (result.groups.length === 0 && result.totalGroups > 0) {
		const clamped =
			Math.floor((result.totalGroups - 1) / page.limit) * page.limit;
		if (clamped !== pageOffset) {
			pageOffset = clamped;
			result = await queryAtOffset(pageOffset);
		}
	}
	if (result.groups.length === 0) {
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
		rows: result.groups.flatMap((group) => group.rows),
		totalCount: result.totalRows,
		grouped: {
			groups: result.groups,
			pageOffset,
			pageSize: page.limit,
			totalGroupCount: result.totalGroups,
		},
		constraintSource: composedQuery.constraintSource,
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
		readonly lookupTableSchemas?: LookupTableSchemas;
		readonly authoredExcludedOwnerIds?: readonly string[];
		readonly restoreScope?: RestoreScope;
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
		lookupTableSchemas: args.lookupTableSchemas,
		predicate: authoredQuery.predicate,
		// The same restore the caller's own count used. This number answers
		// "would clearing Search reveal a case?", and a device that cannot
		// hold the case would not reveal it either.
		restoreScope: args.restoreScope,
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
	const knownInputUuids = new Set(
		caseListConfig?.searchInputs.map((input) => input.uuid) ?? [],
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
					knownInputUuids,
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
						knownInputUuids,
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
				isBlank(prop(caseType, "owner_id")),
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
		lookupTableSchemas?: LookupTableSchemas;
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
		lookupTableSchemas: args.lookupTableSchemas,
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
		lookupTableSchemas: args.lookupTableSchemas,
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
 * When no authored sort applies (`caseListConfig === undefined`, or
 * no column carries `sort`) the keys are the store's default
 * ordering fact spelled explicitly: `date_opened` (creation time),
 * then the id tie-break.
 */
function buildCaseStoreSortKeys(
	caseListConfig: CaseListConfig | undefined,
	caseType: string,
): CaseStoreSortKey[] {
	// Offset pagination needs a total order. Authored keys can tie;
	// the id is unique and deterministic. It carries NO time order —
	// authored opaque ids sort lexically — which is why the unsorted
	// arms lead with `date_opened` rather than leaning on the id.
	const stablePageTieBreaker: CaseStoreSortKey = {
		direction: "asc",
		expression: term(prop(caseType, "case_id")),
	};
	const creationOrder: CaseStoreSortKey = {
		direction: "asc",
		expression: term(prop(caseType, "date_opened")),
	};
	if (caseListConfig === undefined)
		return [creationOrder, stablePageTieBreaker];

	type Survivor = { readonly column: Column; readonly index: number };
	const survivors: Survivor[] = [];
	// Results order — the same independent surface sequence the short-detail
	// wire emitter walks, so equal-priority sort rules break ties identically
	// without coupling the running list to Details rearrangement.
	const sortedColumns = orderedColumns(caseListConfig, "list");
	for (let i = 0; i < sortedColumns.length; i++) {
		const column = sortedColumns[i];
		if (column.sort === undefined) continue;
		survivors.push({ column, index: i });
	}
	if (survivors.length === 0) return [creationOrder, stablePageTieBreaker];

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
		stablePageTieBreaker,
	];
}

/**
 * Read a single case row by id. Case ids are opaque text — any
 * string is a syntactically valid identity — so `missing` covers
 * exactly absent-id and cross-tenant (equivalent under the
 * case-store contract); the running-app view occasionally inherits
 * a stale link from a deleted case, and surfacing it as missing
 * keeps the upstream flow structural.
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
		lookupTableSchemas?: LookupTableSchemas;
		/** The review surface's View case dialog reads a HELD case by
		 * design; running-app callers leave this unset and inherit the
		 * hold (a held case reads as `missing`, like its list absence). */
		includeHeld?: boolean;
		/**
		 * Read as this worker's device would — a device can only open a case
		 * its restore holds, so a canonical Details URL for a case outside it
		 * reads as `missing` exactly as an off-device case does.
		 *
		 * The ancestor walk below inherits nothing and needs nothing: every
		 * parent and host of a live case is itself live (the closure's
		 * up-rule), so the chain cannot leave the restore.
		 */
		restoreScope?: RestoreScope;
	},
): Promise<LoadCaseDataResult> {
	const rows = await store.query({
		appId: args.appId,
		caseType: args.caseType,
		caseTypeSchemas: args.caseTypeSchemas,
		bindings: args.bindings,
		lookupTableSchemas: args.lookupTableSchemas,
		predicate: eq(prop(args.caseType, "case_id"), literal(args.caseId)),
		calculated: args.caseListConfig?.columns.filter(isRuntimeCalculatedColumn),
		limit: 1,
		includeHeld: args.includeHeld,
		restoreScope: args.restoreScope,
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
// Submission envelope
// ---------------------------------------------------------------

/**
 * Map a form engine `SubmissionMutation` onto the case-store's
 * atomic-envelope argument. Pure projection — the engine's four arms
 * translate 1:1 onto the envelope's ordinary action (`survey` becomes
 * `none`), and `CaseStore.applySubmission` lands the whole submission
 * in ONE Postgres transaction: primary write, every child, and the
 * close lifecycle transition together or not at all. The store's
 * insert path plucks each row's `caseName` and rejects an absent one
 * with the canonical compiler-bug invariant (`cases.case_name` is
 * NOT NULL; a valid blueprint always carries the name leaf).
 *
 * The `built` half attaches the server-derived child relationships,
 * operation program, and ordinary action's module case type (the rolling
 * proof's final implicit step), all produced by
 * `buildCaseOperationProgramFromDoc` from the same authorized committed
 * doc the action used to resolve its persona, never client structure.
 */
/** The server-derived halves `submissionEnvelopeArgs` attaches. */
export interface BuiltSubmissionOperations {
	readonly program?: CaseOperationProgram;
	readonly ordinaryCaseType?: string;
	/** Committed case-type relationship for each ordinary child destination.
	 * The client mutation never asserts this wire/runtime fact. */
	readonly ordinaryChildRelationships: ReadonlyMap<
		string,
		NonNullable<CaseType["relationship"]>
	>;
	readonly submissionReceipt?: NonNullable<
		ApplySubmissionArgs["submissionReceipt"]
	>;
	readonly captureIntent?: NonNullable<ApplySubmissionArgs["captureIntent"]>;
}

function canonicalJson(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (
			input === null ||
			typeof input === "string" ||
			typeof input === "number" ||
			typeof input === "boolean"
		) {
			return input;
		}
		if (typeof input === "bigint") return { $bigint: input.toString() };
		if (input instanceof Date) return { $date: input.toISOString() };
		if (input instanceof Map) {
			const entries = [...input.entries()].map(([key, entryValue]) => [
				normalize(key),
				normalize(entryValue),
			]);
			entries.sort((a, b) =>
				JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])),
			);
			return { $map: entries };
		}
		if (input instanceof Set) {
			const entries = [...input].map(normalize);
			entries.sort((a, b) =>
				JSON.stringify(a).localeCompare(JSON.stringify(b)),
			);
			return { $set: entries };
		}
		if (Array.isArray(input)) return input.map(normalize);
		if (typeof input === "object") {
			const normalized: Record<string, unknown> = {};
			for (const key of Object.keys(input).sort()) {
				const entry = (input as Record<string, unknown>)[key];
				if (entry !== undefined) normalized[key] = normalize(entry);
			}
			return normalized;
		}
		return String(input);
	};
	return JSON.stringify(normalize(value));
}

/** Compute the durable entry identity without consulting the current
 * blueprint. This is intentionally the first submission derivation: a receipt
 * accepted under an older capture topology must be adjudicated before today's
 * form/capture structure can reject or erase it. */
export function buildSubmissionReceiptIdentity(args: {
	readonly appId: string;
	readonly identity: ResolvedPreviewIdentity;
	readonly mutation: SubmissionMutation;
	readonly projection: CaptureSubmissionProjection;
	readonly viewerTimeZone?: string;
}): SubmissionReceiptIdentity {
	const { entryKey, formUuid } = args.projection;
	const requestDigest = createHash("sha256")
		.update(
			canonicalJson({
				appId: args.appId,
				mutation: {
					...args.mutation,
					entryKey,
					formUuid,
					attachmentRefs: args.projection.attachmentRefs,
				},
				viewerTimeZone: args.viewerTimeZone,
				identity: {
					actorUserId: args.identity.actorUserId,
					ownerId: args.identity.ownerId,
					personaUuid: args.identity.personaUuid,
				},
			}),
		)
		.digest("hex");
	return { entryKey, formUuid, requestDigest };
}

/**
 * Build the storage executor's `CaseOperationProgram` from the
 * COMMITTED doc — the server is the structural authority, consuming
 * only the client's answer values and iteration counts. The `operations`
 * arm stays absent only when the committed form holds no operations.
 * Missing final-protocol identity, a missing committed form, or absent
 * answer bags for an operation-bearing form rejects the whole submission;
 * none can fall back to ordinary-only effects.
 *
 * Everything structural derives from the shared `caseOperationOrder`
 * analyses over the committed doc: canonical `(order, uuid)` operation sequence,
 * root-then-post-order multiplicity scopes (every scope present even
 * with zero client iterations — the executor requires the entry),
 * transitive producer guards resolved to their condition ASTs, and
 * the immutable expression snapshot types. Identity rides
 * server-resolved: `sessionUser`/`sessionContext` from the
 * authenticated preview identity, never the client.
 *
 * When that exact program carries lookup references, this I/O half also
 * projects their table ids through the canonical production occurrence
 * registry and attaches one Project-authorized, rows-free definitions map.
 * A carrier-free program takes the loader's empty-id fast path and performs no
 * lookup read.
 */
export async function buildSubmissionOperationProgram(args: {
	readonly appId: string;
	readonly committedApp: Pick<AppDoc, "blueprint" | "mutation_seq">;
	readonly identity: ResolvedPreviewIdentity;
	readonly lookupScope: LookupScope;
	readonly mutation: SubmissionMutation;
	readonly projection: CaptureSubmissionProjection;
	readonly viewerTimeZone?: string;
}): Promise<BuiltSubmissionOperations> {
	const receiptIdentity = buildSubmissionReceiptIdentity(args);

	const app = args.committedApp;
	if (app.blueprint.forms[args.projection.formUuid] === undefined) {
		throw new CaptureSubmissionRejectedError(
			"The submitted form no longer exists in the committed app.",
		);
	}
	const built = buildCaseOperationProgramFromDoc({
		blueprint: app.blueprint,
		mutation: args.mutation,
		projection: args.projection,
		identity: args.identity,
		...(args.viewerTimeZone !== undefined && {
			viewerTimeZone: args.viewerTimeZone,
		}),
	});
	/* Attach the program's rows-free lookup-definition snapshot BEFORE the
	 * capture intent, so both augmentations ride one returned value. A
	 * program-free submission has nothing to look up but must still reach
	 * the receipt below — that receipt is what makes an ordinary form's
	 * retry replay instead of repeating its case effects. */
	const withLookups = await withProgramLookupTableSchemas(
		built,
		app.blueprint,
		args.lookupScope,
	);

	const validated = args.projection;
	const allowedAttachments = Object.values(app.blueprint.fields).flatMap(
		(field) => {
			if (!isCaptureFieldKind(field.kind)) return [];
			const path = committedCapturePath(app.blueprint, field.uuid);
			if (path === undefined || path.formUuid !== validated.formUuid) return [];
			return [
				{
					fieldUuid: field.uuid,
					instancePathTemplate: path.instancePathTemplate,
					captureKind: field.kind,
					acceptedFormats: CAPTURE_EXTENSIONS_BY_KIND[field.kind].map(
						(extension) => ({
							extension,
							contentType: captureContentType(extension),
						}),
					),
				},
			];
		},
	);
	// An empty projection from a capture-capable form still participates in
	// the entry-key replay protocol. Otherwise a retry after a committed
	// nonempty submission could bypass its receipt and repeat case effects.
	if (
		validated.attachmentRefs.length === 0 &&
		allowedAttachments.length === 0
	) {
		return {
			...withLookups,
			submissionReceipt: {
				...receiptIdentity,
				expectedAppMutationSeq: app.mutation_seq,
			},
		};
	}
	const captureIntentWithoutDigest = {
		entryKey: validated.entryKey,
		formUuid: validated.formUuid,
		expectedAppMutationSeq: app.mutation_seq,
		requestDigest: receiptIdentity.requestDigest,
		attachments: validated.attachmentRefs,
		allowedAttachments,
	};
	return {
		...withLookups,
		submissionReceipt: {
			...receiptIdentity,
			expectedAppMutationSeq: app.mutation_seq,
		},
		captureIntent: {
			...captureIntentWithoutDigest,
		},
	};
}

/**
 * Attach the Project-authorized, rows-free lookup-definition snapshot the
 * program's own operations reference. Returning the program untouched when
 * it carries no references is the loader's empty-id fast path, so a
 * carrier-free submission performs no lookup read at all.
 */
async function withProgramLookupTableSchemas(
	built: BuiltSubmissionOperations,
	blueprint: AppDoc["blueprint"],
	lookupScope: LookupScope,
): Promise<BuiltSubmissionOperations> {
	if (built.program === undefined) return built;
	const lookupTableSchemas = await loadLookupTableSchemas(
		lookupScope,
		caseOperationProgramLookupTableIds(
			asWalkableDoc(blueprint),
			built.program.operations.map(({ operation }) => operation.uuid),
		),
	);
	if (lookupTableSchemas === undefined) return built;
	return {
		...built,
		program: { ...built.program, lookupTableSchemas },
	};
}

/**
 * Project the canonical production lookup-reference occurrence stream onto
 * the operations in ONE built submission program. Write and link members have
 * no UUID of their own, so the registry deliberately anchors them to their
 * owning operation UUID; filtering carrier identities therefore covers every
 * runtime expression slot without a second hand-maintained AST walker.
 */
export function caseOperationProgramLookupTableIds(
	doc: BlueprintDoc,
	operationUuids: readonly Uuid[],
): readonly LookupTableId[] {
	if (operationUuids.length === 0) return [];
	const activeOperations = new Set<Uuid>(operationUuids);
	return lookupReferenceTargetsFromOccurrences(
		extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		).filter((occurrence) => activeOperations.has(occurrence.carrierUuid)),
	).tableIds;
}

/**
 * Every form field the operations bound to ONE multiplicity scope read.
 *
 * Scope binding is the operation's own `forEach.repeat` — an operation with
 * none runs once against the root bag. Only these references compile for that
 * scope, which is what keeps the completeness check from demanding an answer
 * the submission will never read.
 */
function operationFormFieldRefs(
	operations: readonly CaseOperation[],
	repeatUuid: Uuid | undefined,
): ReadonlySet<Uuid> {
	const refs = new Set<Uuid>();
	/* `field` is a TERM kind, not a ValueExpression kind — walking expression
	 * nodes only ever sees the `{ kind: "term" }` wrapper around it. */
	const note = (term: Term) => {
		if (term.kind === "field") refs.add(term.uuid);
	};
	for (const operation of operations) {
		if (operation.forEach?.repeat !== repeatUuid) continue;
		// A create's `idFrom` is a field reference like any other, and the
		// builder's own `referencedFieldUuids` counts it. Missing it here
		// meant the staleness guard passed and `allocateCreateIdentities`
		// then read an absent answer as the empty key — rejecting the
		// whole submission with a blank-identity error about a question
		// the worker was never shown, instead of asking them to reload.
		if (operation.target.kind === "new" && operation.target.idFrom) {
			refs.add(operation.target.idFrom);
		}
		for (const expression of [
			operation.name,
			operation.owner,
			operation.rename,
			...(operation.target.kind === "expression"
				? [operation.target.expr]
				: []),
			...(operation.links ?? []).flatMap((link) =>
				link.target?.kind === "expression" ? [link.target.expr] : [],
			),
			...(operation.writes ?? []).map((write) => write.value),
		]) {
			if (expression !== undefined) walkExpressionTerms(expression, note);
		}
		for (const predicate of [
			operation.condition,
			...(operation.writes ?? []).flatMap((write) =>
				write.condition === undefined ? [] : [write.condition],
			),
		]) {
			if (predicate !== undefined) walkTerms(predicate, note);
		}
	}
	return refs;
}

/**
 * The pure half: derive the program from ONE committed blueprint. The
 * I/O wrapper above owns the doc load; acceptance tests drive this
 * directly against the storage executor.
 */
export function buildCaseOperationProgramFromDoc(args: {
	readonly blueprint: PersistableDoc;
	readonly mutation: SubmissionMutation;
	readonly projection: CaptureSubmissionProjection;
	readonly identity: ResolvedPreviewIdentity;
	readonly viewerTimeZone?: string;
}): BuiltSubmissionOperations {
	const { mutation } = args;
	const formUuid = args.projection.formUuid;
	const blueprint = args.blueprint;
	const doc = asWalkableDoc(blueprint);
	const form = doc.forms[formUuid];
	if (form === undefined) {
		throw new CaptureSubmissionRejectedError(
			"The submitted form no longer exists in the committed app.",
		);
	}
	const caseTypeSchemas = buildCaseTypeMap(blueprint);
	const ordinaryChildRelationships = new Map(
		[...caseTypeSchemas].map(
			([caseType, definition]) =>
				[caseType, definition.relationship ?? "child"] as const,
		),
	);
	const ordinaryCaseType = owningModuleCaseType(doc, formUuid);
	const ordinaryStructure = {
		ordinaryChildRelationships,
		...(ordinaryCaseType === undefined ? {} : { ordinaryCaseType }),
	};
	const operations = orderedCaseOperations(form);
	if (operations.length === 0) return ordinaryStructure;
	/* Operations present but NO collected answers means the client's doc
	 * snapshot predates a co-editor's operation add. Running with empty
	 * bindings would blank-write fields, while silently submitting the
	 * ordinary arm would skip committed behavior. Reject the whole
	 * submission and let the refreshed client retry the final protocol. */
	if (mutation.operationAnswers === undefined) {
		throw new CaptureSubmissionRejectedError(
			"The submitted form is missing answers required by its committed case operations.",
		);
	}

	const guards = caseOperationConditionalGuardUuids(doc, formUuid, operations);
	const snapshotTypes = caseOperationExpressionSnapshotTypes(
		doc,
		formUuid,
		operations,
	);
	const operationsByUuid = new Map(operations.map((op) => [op.uuid, op]));
	const envelopeOperations = operations.map((operation) => {
		const guardConditions = [...(guards.get(operation.uuid) ?? [])]
			.map((uuid) => operationsByUuid.get(uuid)?.condition)
			.filter((condition): condition is Predicate => condition !== undefined);
		const snapshot = snapshotTypes.get(operation.uuid);
		return {
			operation,
			guardConditions,
			expressionSnapshotTypes: {
				...(snapshot?.target !== undefined && { target: snapshot.target }),
				links: snapshot?.links ?? new Map<number, string>(),
			},
		};
	});

	const answers = mutation.operationAnswers;
	const answerMap = (
		entries: ReadonlyArray<SubmissionAnswerEntry> | undefined,
	): ReadonlyMap<Uuid, string | readonly string[]> =>
		new Map(
			(entries ?? []).map((entry) => [asUuid(entry.fieldUuid), entry.value]),
		);
	/* A repeat the COMMITTED doc scopes an operation over, with no scope in
	 * the payload, is provable staleness rather than an empty repeat.
	 * `FormEngine.computeOperationAnswers` registers a scope for every repeat
	 * in the client's OWN doc before counting its instances, so a worker who
	 * simply added no rows still sends that repeat with an empty iteration
	 * list. Absent means the client never knew the repeat existed — a
	 * co-editor added it, and this snapshot predates the commit.
	 *
	 * Distinguishing the two is the whole point: `?? []` reads an absent
	 * scope as zero iterations, so the operation runs zero times and the
	 * submission reports success while committed case effects never
	 * happened. That is the same silent skip the guard above refuses, one
	 * level deeper. */
	const requiredScopes = caseOperationMultiplicityScopes(doc, formUuid);
	const suppliedRepeats = new Set(answers.repeats.map((scope) => scope.repeat));
	const missingRepeats = requiredScopes.filter(
		(repeatUuid): repeatUuid is Uuid =>
			repeatUuid !== undefined && !suppliedRepeats.has(repeatUuid as string),
	);
	if (missingRepeats.length > 0) {
		throw new CaptureSubmissionRejectedError(
			"The submitted form is missing answers for a repeat its committed case operations run over. Reload the form and submit again.",
		);
	}

	const scopes = requiredScopes.map((repeatUuid) => {
		if (repeatUuid === undefined) {
			return { iterations: [{ formFields: answerMap(answers.root) }] };
		}
		const clientScope = answers.repeats.find(
			(scope) => scope.repeat === (repeatUuid as string),
		);
		return {
			repeat: repeatUuid,
			iterations: (clientScope?.iterations ?? []).map((bag) => ({
				formFields: answerMap(bag),
			})),
		};
	});

	/* The same staleness one level finer. A peer can add a FIELD an operation
	 * reads without adding a repeat, so the scope arrives and its iterations
	 * simply lack that answer. That reference reaches `compileBoundRef`, which
	 * has no fallback for a form field — deliberately, since a blank would
	 * change a predicate's truth value — and throws a developer-voiced
	 * invariant naming `ctx.bindings`. With no arm in `mapSubmitFormError`
	 * that text becomes the WORKER's submission error and fires a Sentry
	 * alert, for what is an ordinary multiplayer race.
	 *
	 * Checked per scope against the iterations that will actually compile: a
	 * field inside a repeat the worker left empty is never read, so requiring
	 * it would reject an honest submission. */
	const missingFieldScopes = scopes.filter((scope) => {
		if (scope.iterations.length === 0) return false;
		const referenced = operationFormFieldRefs(
			envelopeOperations.map(({ operation }) => operation),
			"repeat" in scope ? scope.repeat : undefined,
		);
		return scope.iterations.some((iteration) =>
			[...referenced].some((fieldUuid) => !iteration.formFields.has(fieldUuid)),
		);
	});
	if (missingFieldScopes.length > 0) {
		throw new CaptureSubmissionRejectedError(
			"The submitted form is missing an answer its committed case operations read. Reload the form and submit again.",
		);
	}

	const sessionContext = new Map<string, string>();
	for (const [field, value] of Object.entries(args.identity.session.context)) {
		if (value !== undefined) sessionContext.set(field, value);
	}
	return {
		...ordinaryStructure,
		program: {
			formUuid,
			operations: envelopeOperations,
			scopes,
			...(mutation.kind === "followup" || mutation.kind === "close"
				? { sessionCaseId: mutation.caseId }
				: {}),
			caseTypeSchemas,
			organizationLevels: organizationLevelsOf(doc),
			sessionUser: new Map(Object.entries(args.identity.session.user)),
			userPropertySlugs: new Map(
				Object.entries(args.identity.session.userPropertySlugs),
			),
			sessionContext,
			...(args.viewerTimeZone === undefined
				? {}
				: { viewerTimeZone: args.viewerTimeZone }),
		},
	};
}

/** The module owning `formUuid`, walked off the committed doc. */
function owningModuleCaseType(
	doc: BlueprintDoc,
	formUuid: Uuid,
): string | undefined {
	for (const moduleUuid of doc.moduleOrder) {
		if (doc.formOrder[moduleUuid]?.includes(formUuid)) {
			return doc.modules[moduleUuid]?.caseType;
		}
	}
	return undefined;
}

export function submissionEnvelopeArgs(
	mutation: SubmissionMutation,
	appId: string,
	built: BuiltSubmissionOperations,
): ApplySubmissionArgs {
	if (built.submissionReceipt === undefined) {
		throw new Error(
			compilerBugMessage({
				where: "preview.caseDataBindingHelpers.submissionEnvelopeArgs",
				invariant:
					"an atomic submission envelope was built without its durable receipt claim",
				detail:
					"Every form entry, including a text-only survey, must be derived through `buildSubmissionOperationProgram` before it reaches the case store.",
			}),
		);
	}
	const operations =
		built.program === undefined ? {} : { operations: built.program };
	const captureIntent =
		built.captureIntent === undefined
			? {}
			: { captureIntent: built.captureIntent };
	const submissionReceipt = { submissionReceipt: built.submissionReceipt };
	const childSeed = <T extends { readonly caseType: string }>(child: T) => {
		const parentRelationship = built.ordinaryChildRelationships.get(
			child.caseType,
		);
		if (parentRelationship === undefined) {
			throw new Error(
				compilerBugMessage({
					where: "preview.caseDataBindingHelpers.submissionEnvelopeArgs",
					invariant: `ordinary child case type \`${child.caseType}\` has no committed relationship projection`,
					detail:
						"The server must derive every ordinary child's parent relationship from the same committed case-type catalog that authorized the submission. Without it, the case store would silently collapse an extension host into an ordinary child edge.",
				}),
			);
		}
		return { ...child, parentRelationship };
	};
	switch (mutation.kind) {
		case "registration":
			return {
				appId,
				ordinary: {
					kind: "registration",
					primary: mutation.primary,
					children: mutation.children.map(childSeed),
				},
				...operations,
				...submissionReceipt,
				...captureIntent,
			};
		case "followup":
		case "close":
			return {
				appId,
				ordinary: {
					kind: mutation.kind,
					caseId: mutation.caseId,
					...(built.ordinaryCaseType !== undefined && {
						caseType: built.ordinaryCaseType,
					}),
					patch: mutation.patch,
					children: mutation.children.map(childSeed),
				},
				...operations,
				...submissionReceipt,
				...captureIntent,
			};
		case "survey":
			return {
				appId,
				ordinary: { kind: "none" },
				...operations,
				...submissionReceipt,
				...captureIntent,
			};
		default: {
			const _exhaustive: never = mutation;
			throw new Error(
				compilerBugMessage({
					where: "preview.caseDataBindingHelpers.submissionEnvelopeArgs",
					invariant: `unknown SubmissionMutation kind \`${String((_exhaustive as { kind?: unknown })?.kind)}\``,
					detail:
						"The four engine arms map exhaustively onto the envelope's ordinary action; a new arm must decide its envelope shape here.",
				}),
			);
		}
	}
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
 * `run` MUST be a single store operation, never a multi-call dispatch —
 * the granularity is the retry-safety argument. Each store method is
 * atomic (one statement or one Postgres transaction) and throws BOTH of
 * these errors before its own transaction commits (validator acquisition
 * and JSON Schema validation precede the writes, and a throw rolls the
 * transaction back), so the operation that threw is by definition the
 * one that didn't land and re-running just it is idempotent. That
 * includes `applySubmission`: the whole submission is ONE transaction,
 * so its heal retry re-runs the whole envelope with nothing partial
 * persisted. Production code reaches this through
 * `schemaHealingCaseStore`, which holds that granularity by
 * construction.
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
		await drainPendingCaseSchemaIndexes(args.appId);
	} catch (error) {
		log.warn("[caseDataBinding] pending index convergence failed", {
			appId: args.appId,
			error,
		});
	}
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
 * Resolve a member identity, or project a persona from a document the caller
 * already owns. Member-only case-data actions use this low-level helper;
 * app-facing persona selectors use `resolveAuthorizedPreviewContext` so access
 * is proven before the document is loaded. `null` means no authenticated
 * worker. The client never supplies an identity to an action.
 */
export async function resolvePreviewIdentity(
	doc?: UserCollections,
	personaUuid?: string,
	projectSpace?: string | null,
): Promise<ResolvedPreviewIdentity | null> {
	const session = await getSession();
	if (!session) return null;
	if (doc === undefined || personaUuid === undefined) {
		return previewAsMe(session.user, doc, projectSpace);
	}
	// This low-level projection is used only when the caller already owns the
	// document. App-facing selectors use `resolveAuthorizedPreviewContext`,
	// whose stale-persona arm refuses rather than changing worker identities.
	const persona = ownRecordValue(personasOf(doc), personaUuid);
	if (persona === undefined)
		return previewAsMe(session.user, doc, projectSpace);
	return previewAsPersona(session.user, persona, doc, projectSpace);
}

/**
 * One authorized action context. Membership is proven before any blueprint
 * read, the selected persona resolves only from that authorized snapshot,
 * and the store keeps the Nova actor separate from the CommCare owner.
 */
export type AuthorizedPreviewContext =
	| { kind: "unauthenticated" }
	| { kind: "persona-unavailable"; message: string }
	| {
			kind: "ready";
			identity: ResolvedPreviewIdentity;
			store: CaseStore;
			scope: LookupScope;
			blueprint?: PersistableDoc;
			/**
			 * What this worker's device would hold — pass it to every RUNNING
			 * read and to none of the authoring ones.
			 *
			 * It rides here rather than on `ResolvedPreviewIdentity` because it
			 * is not part of the evaluation world. The identity is the ONE
			 * contract the browser and the server both speak, and the browser
			 * cannot derive this: expanding a persona's assignments into the
			 * places it receives cases from reads the app's place tree out of
			 * Postgres. Putting a server-only field on the shared identity would
			 * make the client's copy quietly wrong, and `samePreviewIdentity`
			 * would then compare a field only one side can fill.
			 */
			restoreScope: RestoreScope;
	  };

export const PERSONA_UNAVAILABLE_MESSAGE =
	"The selected preview persona is no longer available. Choose another worker and try again.";

export async function resolveAuthorizedPreviewContext(args: {
	readonly appId: string;
	readonly personaUuid?: string;
	readonly required: AppCapability;
	/** Submission program derivation needs the committed blueprint even while
	 * previewing as the signed-in member. Persona selection implies a load. */
	readonly loadBlueprint?: boolean;
}): Promise<AuthorizedPreviewContext> {
	const session = await getSession();
	const memberIdentity = previewAsMe(session?.user);
	if (memberIdentity === null) return { kind: "unauthenticated" };

	// The app id is client input. Blueprint-needed paths use the locked
	// authorization snapshot so membership, Project, cursor, and document
	// cannot straddle a concurrent app move or commit. Member-only paths avoid
	// the full document through the lightweight scope resolver.
	const needsBlueprint =
		args.loadBlueprint === true || args.personaUuid !== undefined;
	const snapshot = needsBlueprint
		? await resolveAuthorizedAppSnapshot(
				args.appId,
				memberIdentity.actorUserId,
				args.required,
			)
		: undefined;
	const access =
		snapshot ??
		(await resolveAppScope(
			args.appId,
			memberIdentity.actorUserId,
			args.required,
		));
	const blueprint = snapshot?.app.blueprint;
	if (needsBlueprint && blueprint === undefined) {
		throw new Error("The app changed while Preview was loading it.");
	}

	/* The SAME project space the client form engine sees. This identity is
	 * what binds `sessionUser` for the SQL compiler, so leaving it out here
	 * while the browser's copy carries it would make one expression answer
	 * two ways depending on which side evaluated it — the hardest kind of
	 * difference to notice, because both halves look right alone. */
	const projectSpace = await previewProjectSpaceFor({
		appId: args.appId,
		projectId: access.projectId,
		role: access.role,
		actorUserId: memberIdentity.actorUserId,
	});

	/* `memberIdentity` above proved the session exists, so every
	 * `previewAsMe` here returns non-null for the same user; the earlier
	 * `?? memberIdentity` fallbacks were unreachable and the no-blueprint
	 * identity was rebuilt and discarded whenever one was loaded. */
	let identity =
		blueprint === undefined
			? (previewAsMe(session?.user, undefined, projectSpace) ?? memberIdentity)
			: memberIdentity;
	if (blueprint !== undefined) {
		if (args.personaUuid === undefined) {
			identity =
				previewAsMe(session?.user, blueprint, projectSpace) ?? memberIdentity;
		} else {
			const persona = ownRecordValue(personasOf(blueprint), args.personaUuid);
			if (persona === undefined) {
				return {
					kind: "persona-unavailable",
					message: PERSONA_UNAVAILABLE_MESSAGE,
				};
			}
			const resolved = previewAsPersona(
				session?.user,
				persona,
				blueprint,
				projectSpace,
			);
			if (resolved === null) return { kind: "unauthenticated" };
			identity = resolved;
		}
	}

	return {
		kind: "ready",
		identity,
		restoreScope: await resolveRestoreScope({
			appId: args.appId,
			identity,
			blueprint,
		}),
		store: schemaHealingCaseStore(
			await withProjectContext(
				access.projectId,
				identity.actorUserId,
				identity.ownerId,
			),
			{ appId: args.appId },
		),
		scope: {
			projectId: access.projectId,
			actorId: identity.actorUserId,
			role: access.role,
		},
		...(blueprint !== undefined && { blueprint }),
	};
}

/**
 * The owner ids seeding this preview's restore.
 *
 * `CouchUser.get_owner_ids` is the worker's own id plus one per case-sharing
 * group, and in Nova every group is a place the persona receives cases from.
 * Previewing as the signed-in member is a worker assigned nowhere, so it is
 * their own id and nothing else — a real answer, not a degraded one.
 *
 * The place tree is read only when a persona could actually reach one. An app
 * with no organization gives every persona its own uuid and nothing more, and
 * that is derivable from the document alone, so the common case adds no query
 * to a case-list render.
 */
async function resolveRestoreScope(args: {
	readonly appId: string;
	readonly identity: ResolvedPreviewIdentity;
	readonly blueprint: PersistableDoc | undefined;
}): Promise<RestoreScope> {
	const { appId, identity, blueprint } = args;
	const personaUuid = identity.personaUuid;
	if (personaUuid === undefined || blueprint === undefined) {
		return { ownerIds: memberOwnerIds(identity.actorUserId) };
	}
	const persona = ownRecordValue(personasOf(blueprint), personaUuid);
	if (persona === undefined) {
		// Unreachable through `resolveAuthorizedPreviewContext`, which refuses a
		// missing persona above rather than falling back to the member.
		return { ownerIds: memberOwnerIds(identity.actorUserId) };
	}
	if (assignedLocationUuids(persona.locations).length === 0) {
		return { ownerIds: personaOwnerIds(blueprint, persona, []) };
	}
	const { rows } = await readOrganizationTopology(appId);
	return { ownerIds: personaOwnerIds(blueprint, persona, rows) };
}

export async function gatedCaseStore(
	appId: string,
	identity: ResolvedPreviewIdentity,
	required: AppCapability,
): Promise<CaseStore> {
	return (await gatedCaseStoreWithScope(appId, identity, required)).store;
}

/**
 * `gatedCaseStore` plus the resolved Project scope — for actions that
 * additionally read Project-scoped lookup definitions with the SAME
 * membership authorization the store resolution proved.
 */
export async function gatedCaseStoreWithScope(
	appId: string,
	identity: ResolvedPreviewIdentity,
	required: AppCapability,
): Promise<{
	store: CaseStore;
	scope: LookupScope;
	projectId: string;
	role: string;
}> {
	// `actorUserId` — never `ownerId`. The owner may be a persona, which is
	// authored blueprint content; keying membership on it would let an app
	// choose whose data a request reads. The persona reaches the store only
	// as the CommCare worker whose `owner_id` new rows carry.
	const { projectId, role } = await resolveAppScope(
		appId,
		identity.actorUserId,
		required,
	);
	return {
		store: schemaHealingCaseStore(
			await withProjectContext(
				projectId,
				identity.actorUserId,
				identity.ownerId,
			),
			{ appId },
		),
		scope: { projectId, actorId: identity.actorUserId, role },
		projectId,
		role,
	};
}

/**
 * Every lookup table the config's SQL-bound slots reference: the
 * always-on filter, calculated columns, and advanced search-input
 * predicates all compose into `store.query`'s predicate/projection,
 * so any `table-lookup` inside them needs the compiler's definitions
 * snapshot. Extra expressions (the excluded-owner value) join the
 * same sweep so one call covers an action's whole payload.
 */
export function collectConfigLookupTableIds(
	caseListConfig: CaseListConfig | undefined,
	extraExpressions: readonly ValueExpression[] = [],
): readonly LookupTableId[] {
	const ids = new Set<LookupTableId>();
	const hooks = {
		mapExpression: (expr: ValueExpression) => {
			if (expr.kind === "table-lookup") ids.add(expr.tableId);
			// Returning undefined descends — a nested lookup inside a
			// `where` is collected by the same hook.
			return undefined;
		},
	};
	if (caseListConfig !== undefined) {
		if (caseListConfig.filter !== undefined) {
			mapPredicateAst(caseListConfig.filter, hooks);
		}
		for (const column of caseListConfig.columns) {
			if (column.kind === "calculated") {
				mapExpressionAst(column.expression, hooks);
			}
		}
		for (const input of caseListConfig.searchInputs) {
			if (input.kind === "advanced") {
				mapPredicateAst(input.predicate, hooks);
			}
		}
	}
	for (const expression of extraExpressions) {
		mapExpressionAst(expression, hooks);
	}
	return [...ids].sort();
}

/**
 * Rows-free lookup definition types for the SQL compiler, from one
 * Project-scoped snapshot. Missing/foreign ids are silently absent —
 * the compiler's `requireLookupColumnType` invariant owns the loud
 * failure if a carrier then compiles against a gap.
 */
/**
 * Fixture data (definitions + complete ordered rows) for the lookup
 * tables ONE scalar-evaluated expression references — the fold input
 * for the excluded-owner value, which resolves server-side rather
 * than compiling to SQL. `undefined` when the expression is absent or
 * carrier-free, so the common path loads nothing.
 */
export async function loadExpressionLookupData(
	scope: LookupScope,
	expression: ValueExpression | undefined,
): Promise<PreviewLookupData | undefined> {
	if (expression === undefined) return undefined;
	const tableIds = collectConfigLookupTableIds(undefined, [expression]);
	if (tableIds.length === 0) return undefined;
	return previewLookupData(await getLookupFixtureData(scope, tableIds));
}

export async function loadLookupTableSchemas(
	scope: LookupScope,
	tableIds: readonly LookupTableId[],
): Promise<LookupTableSchemas | undefined> {
	if (tableIds.length === 0) return undefined;
	const snapshot = await getLookupDefinitions(scope, tableIds);
	return new Map(
		snapshot.definitions.map((table) => [
			table.id as string,
			new Map(
				table.columns.map((column) => [column.id as string, column.dataType]),
			),
		]),
	);
}

/**
 * A `CaseStore` whose every operation self-heals a missing OR stale
 * `case_type_schemas` row via {@link withSchemaHeal} — the heal lives at
 * the INDIVIDUAL store call. Each store operation is atomic (one
 * statement or one Postgres transaction) and throws the heal's signals
 * before its own write commits, so retrying just the operation that
 * threw is idempotent. `applySubmission` is one such operation at the
 * ENVELOPE boundary: the whole submission lands in a single
 * transaction, so a heal retry re-runs the whole envelope safely —
 * nothing partial persisted.
 *
 * `applySchemaChange` delegates un-healed: it is the
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
		queryGrouped: (a) => heal(() => store.queryGrouped(a)),
		count: (a) => heal(() => store.count(a)),
		insert: (a) => heal(() => store.insert(a)),
		applySubmission: (a) => heal(() => store.applySubmission(a)),
		update: (a) => heal(() => store.update(a)),
		close: (a) => heal(() => store.close(a)),
		traverse: (a) => heal(() => store.traverse(a)),
		applySchemaChange: (a) => store.applySchemaChange(a),
		// Un-healed: a read-only preview over raw rows — its cast checks
		// value shape against the DESTINATION type, never the stored
		// schema row, so the heal's missing/stale-schema signal can't
		// arise here.
		conversionImpact: (a) => store.conversionImpact(a),
		// Un-healed like the schema writers above: it validates nothing
		// (migrations are the trusted writer layer), so the heal's
		// missing/stale-schema remedy has nothing to catch here.
		unparkValues: (a) => store.unparkValues(a),
		// Un-healed for the same reason: the restore verdicts and the
		// restore writes gate on conformance against the STORED schema
		// row (answering "blocked"/false on an absent one), and the
		// dismiss toggle touches only the park table — none of the
		// three can throw the heal's missing/stale-schema signal.
		listParkedValues: (a) => store.listParkedValues(a),
		restoreParkedValues: (a) => store.restoreParkedValues(a),
		setParkedValuesDismissed: (a) => store.setParkedValuesDismissed(a),
		// Healed: the replacement flows through the standard validated
		// `update`, whose per-case-type validator acquisition is exactly
		// what a missing/stale schema row makes throw.
		replaceParkedValue: (a) => heal(() => store.replaceParkedValue(a)),
		generateSampleData: (a) => heal(() => store.generateSampleData(a)),
		resetSampleData: (a) => heal(() => store.resetSampleData(a)),
	};
}
