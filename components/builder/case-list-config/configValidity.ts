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
//     known inputs — the context `FilterInspector`'s
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
//   - `filterBroken` — the one non-row Results finding, used to mark the
//     Cases included summary directly so every tab dot leads somewhere.

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
	/** The Results canvas marks its one filter summary row directly so a
	 *  problem remains findable even when no result fields are visible. */
	readonly filterBroken: boolean;
}

export function caseListConfigVerdicts(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): CaseListConfigVerdicts {
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

	// ── Filter ──
	let filterIsBroken = false;
	if (config.filter !== undefined) {
		const filterCtx: TypeContext = {
			caseTypes: [...caseTypes],
			knownInputs: [...config.searchInputs],
			currentCaseType,
		};
		filterIsBroken = !checkPredicate(config.filter, filterCtx).ok;
	}

	// ── Search inputs ──
	// An advanced predicate resolves `input(...)` against EVERY named
	// row — the full scope the validator's `moduleTypeContext` and the
	// wire emitter use. Hoisted out of the loop: it doesn't vary per row.
	let search = false;
	const inputDecls = searchInputDecls(
		config.searchInputs,
		caseTypes,
		currentCaseType,
	);
	const resolved = resolveRows(config.searchInputs, caseTypes, currentCaseType);
	for (let i = 0; i < config.searchInputs.length; i++) {
		const row = config.searchInputs[i];
		const rowResolved = resolved[i];
		if (row === undefined || rowResolved === undefined) continue;
		if (rowHasStructuralError(rowResolved)) {
			search = true;
			continue;
		}

		// Default values run BEFORE the search screen opens, so they
		// resolve NO `input(...)` ref — mirror the editor's
		// NO_SEARCH_INPUTS scope (and the commit gate's forbids-input-ref
		// rule). Session / user-data refs still resolve without it.
		if (row.default !== undefined) {
			const defaultCtx: TypeContext = {
				caseTypes: [...caseTypes],
				knownInputs: [...NO_SEARCH_INPUTS],
				currentCaseType,
			};
			const verdict = checkValueExpression(
				row.default,
				defaultCtx,
				expectedTypeForDefault(row.type),
			);
			if (!verdict.ok) search = true;
		}
		if (row.kind === "advanced") {
			const predicateCtx: TypeContext = {
				caseTypes: [...caseTypes],
				knownInputs: [...inputDecls],
				currentCaseType,
			};
			if (!checkPredicate(row.predicate, predicateCtx).ok) search = true;
		}
	}

	return {
		errorAreas: {
			search,
			list: listColumnsBroken || filterIsBroken,
			detail: detailColumnsBroken,
		},
		brokenColumns,
		filterBroken: filterIsBroken,
	};
}
