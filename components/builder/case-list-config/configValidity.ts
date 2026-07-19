// components/builder/case-list-config/configValidity.ts
//
// Pure whole-config verdicts for `CaseListConfig`. The workspace
// mounts at most one editor (the inspected entity), so every verdict
// is derived from the config alone. Callers pass the EFFECTIVE case
// types (`useEffectiveCaseTypes` — the same view the commit gate's
// validator resolves against), so these verdicts can't disagree with
// the gate.
//
// Each check mirrors the corresponding editor's own verdict source so
// the derivation can't disagree with what the inspector shows:
//
//   - columns: the per-kind applicability predicate from
//     `columnEditorSchemas` (what `ColumnEditor` surfaces inline, and
//     the same domain predicate the gate's kind-vs-type rule runs);
//     calculated columns run `checkValueExpression` with the same
//     bare context `CalculatedColumnCard`'s editor builds.
//   - filter: `checkPredicate` with the full search-input list as
//     known inputs — the context Results' Cases available
//     `PredicateCardEditor` receives.
//   - search inputs: the structural row resolution from
//     `searchInputResolution` plus per-row default-expression (no
//     inputs in scope) / advanced-predicate (every named row in scope)
//     checks — exactly the editors `SearchInputEditor` mounts.
//
// ONE walk produces three answers, because they gate different
// surfaces:
//
//   - `errorAreas` — which tabs carry the error dot: every finding,
//     including search-input problems and column-kind applicability
//     mismatches. A broken column badges only the screen that shows it;
//     off-screen sort carriers belong to Results because Default order uses
//     them. Hidden recovery items never make an unrelated tab look broken.
//   - `brokenColumns` — the per-column set behind the in-canvas
//     error marks (a tab dot must point at something findable).
//   - `filterBroken` — used to mark Results' Cases available composer
//     directly so every tab dot leads somewhere.

import { caseSearchPredicateVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { CaseWorkspaceBoundaryVerdicts } from "@/lib/doc/hooks/useCaseWorkspaceVerdicts";
import {
	type CaseListConfig,
	type CaseType,
	type Column,
	caseListColumnHasRuntimeRole,
	type Uuid,
} from "@/lib/domain";
import {
	checkPredicate,
	checkValueExpression,
	type TypeContext,
} from "@/lib/domain/predicate";
import {
	columnCardSchemas,
	resolveColumnProperty,
} from "./columnEditorSchemas";
import {
	expectedTypeForDefault,
	NO_SEARCH_INPUTS,
	resolveRows,
	rowHasStructuralError,
	searchInputDecls,
} from "./searchInputResolution";

/** Which workspace tabs currently host a configuration error — the
 *  tab strip badges these so a problem on an unopened tab is visible
 *  from anywhere in the workspace. */
export interface CaseListConfigErrorAreas {
	readonly search: boolean;
	readonly list: boolean;
	readonly detail: boolean;
}

export interface CaseListConfigVerdicts {
	readonly errorAreas: CaseListConfigErrorAreas;
	readonly brokenColumns: ReadonlySet<Uuid>;
	/** The Results canvas marks its filter composer directly so a
	 *  problem remains findable even when no result fields are visible. */
	readonly filterBroken: boolean;
	/** Imported Search-action rules need a distinct mark in Search settings. */
	readonly searchButtonConditionBroken: boolean;
	/** Assigned-case expressions live in Results beside Cases available. */
	readonly excludedOwnerIdsBroken: boolean;
}

export interface CaseListConfigVerdictOptions {
	readonly caseSearchEnabled?: boolean;
	/** Absolute module-rule findings projected from the live BlueprintDoc. */
	readonly boundary?: CaseWorkspaceBoundaryVerdicts;
}

const CLEAN_BOUNDARY: CaseWorkspaceBoundaryVerdicts = {
	filterBroken: false,
	searchInputsBroken: false,
	searchButtonConditionBroken: false,
	excludedOwnerIdsBroken: false,
	brokenColumnUuids: [],
};

export function caseListConfigVerdicts(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
	options: CaseListConfigVerdictOptions = {},
): CaseListConfigVerdicts {
	const caseSearchEnabled =
		options.caseSearchEnabled ?? config.searchInputs.length > 0;
	const boundary = options.boundary ?? CLEAN_BOUNDARY;
	const editCtx = { caseTypes, currentCaseType };
	const bareCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [],
		currentCaseType,
	};

	// ── Columns — one pass feeds the marks and tab dots. ──
	const brokenColumns = new Set<Uuid>();
	let listColumnsBroken = false;
	let detailColumnsBroken = false;
	const markBrokenColumn = (column: Column) => {
		brokenColumns.add(column.uuid);
		if (column.visibleInList !== false || column.sort !== undefined) {
			listColumnsBroken = true;
		}
		if (column.visibleInDetail !== false) detailColumnsBroken = true;
	};
	for (const col of config.columns) {
		if (!caseListColumnHasRuntimeRole(col)) continue;
		if (col.kind === "calculated") {
			if (checkValueExpression(col.expression, bareCtx).ok) continue;
			markBrokenColumn(col);
			continue;
		}
		const applicable = columnCardSchemas[col.kind].applicableForProperty(
			resolveColumnProperty(editCtx, col.field),
		);
		if (!applicable) markBrokenColumn(col);
	}
	for (const uuid of boundary.brokenColumnUuids) {
		const column = config.columns.find((candidate) => candidate.uuid === uuid);
		if (column !== undefined && caseListColumnHasRuntimeRole(column)) {
			markBrokenColumn(column);
		}
	}

	// Search widgets expose their runtime scalar type, not the targeted case
	// property's type. This is the same domain mapping the gate and Preview use.
	const inputDecls = searchInputDecls(config.searchInputs);

	// ── Filter ──
	let filterIsBroken = boundary.filterBroken;
	if (config.filter !== undefined) {
		const filterCtx: TypeContext = {
			caseTypes: [...caseTypes],
			knownInputs: [...inputDecls],
			currentCaseType,
		};
		filterIsBroken =
			filterIsBroken ||
			!checkPredicate(config.filter, filterCtx).ok ||
			(caseSearchEnabled && !caseSearchPredicateVerdict(config.filter).ok);
	}

	// ── Search inputs ──
	// Both per-row check contexts are row-invariant, so they build once.
	// Default values run BEFORE the search screen opens, so they resolve
	// NO `input(...)` ref — mirror the editor's NO_SEARCH_INPUTS scope
	// (and the commit gate's forbids-input-ref rule); session / user-data
	// refs still resolve without it. An advanced predicate resolves
	// `input(...)` against EVERY named row — the full scope the
	// validator's `moduleTypeContext` and the wire emitter use.
	const defaultCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [...NO_SEARCH_INPUTS],
		currentCaseType,
	};
	const predicateCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [...inputDecls],
		currentCaseType,
	};
	let search =
		boundary.searchInputsBroken || boundary.searchButtonConditionBroken;
	const resolved = resolveRows(config.searchInputs, caseTypes, currentCaseType);
	for (let i = 0; i < config.searchInputs.length; i++) {
		const row = config.searchInputs[i];
		const rowResolved = resolved[i];
		if (row === undefined || rowResolved === undefined) continue;
		if (rowHasStructuralError(rowResolved)) {
			search = true;
			continue;
		}

		if (row.default !== undefined) {
			// A daterange answer is an indivisible start/end pair on the wire.
			// The legacy scalar default slot cannot represent it faithfully, so
			// keep Preview gated until the author removes that imported setting.
			if (row.type === "date-range") {
				search = true;
				continue;
			}
			const verdict = checkValueExpression(
				row.default,
				defaultCtx,
				expectedTypeForDefault(row.type),
			);
			if (!verdict.ok) search = true;
		}
		if (row.kind === "advanced") {
			if (
				!checkPredicate(row.predicate, predicateCtx).ok ||
				!caseSearchPredicateVerdict(row.predicate).ok
			) {
				search = true;
			}
		}
	}

	return {
		errorAreas: {
			search,
			list:
				listColumnsBroken || filterIsBroken || boundary.excludedOwnerIdsBroken,
			detail: detailColumnsBroken,
		},
		brokenColumns,
		filterBroken: filterIsBroken,
		searchButtonConditionBroken: boundary.searchButtonConditionBroken,
		excludedOwnerIdsBroken: boundary.excludedOwnerIdsBroken,
	};
}
