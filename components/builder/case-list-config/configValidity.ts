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
//     mismatches. A broken column badges BOTH the list and detail
//     tabs — both canvases keep omitted columns in a supporting-field
//     inventory, and an inventory containing an error opens itself so
//     the entity is findable and fixable from either.
//   - `brokenColumns` — the per-column set behind the in-canvas
//     error marks (a tab dot must point at something findable).
//   - `previewObstacle` — why the live preview can't run, or `null`:
//     ONLY the ASTs the case-store SQL compiler actually consumes
//     (the filter + calculated-column expressions), where an invalid
//     AST would throw at the SQL layer. An applicability mismatch or
//     a search-input problem never blanks the live table — those
//     rows still load and render fine; the marks + inspector carry
//     the signal.

import type { CaseListConfig, CaseType, Column, Uuid } from "@/lib/domain";
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
	readonly previewObstacle: string | null;
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

	// ── Columns — one pass feeds the marks, the tab dots, AND the
	// preview gate's calculated arm. ──
	const brokenColumns = new Set<Uuid>();
	const brokenCalculated: Column[] = [];
	for (const col of config.columns) {
		if (col.kind === "calculated") {
			if (checkValueExpression(col.expression, bareCtx).ok) continue;
			brokenColumns.add(col.uuid);
			brokenCalculated.push(col);
			continue;
		}
		const applicable = columnCardSchemas[col.kind].applicableForProperty(
			resolveColumnProperty(editCtx, col.field),
		);
		if (!applicable) brokenColumns.add(col.uuid);
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

	const columnsBroken = brokenColumns.size > 0;
	return {
		errorAreas: {
			search,
			list: columnsBroken || filterIsBroken,
			detail: columnsBroken,
		},
		brokenColumns,
		previewObstacle: composePreviewObstacle(filterIsBroken, brokenCalculated),
	};
}

/** The paused-preview notice, naming the thing to open. */
function composePreviewObstacle(
	filterIsBroken: boolean,
	brokenCalculated: readonly Column[],
): string | null {
	const total = (filterIsBroken ? 1 : 0) + brokenCalculated.length;
	if (total === 0) return null;

	const parts: string[] = [];
	if (filterIsBroken) parts.push("the filter");
	if (brokenCalculated.length === 1) {
		const header = brokenCalculated[0]?.header;
		parts.push(
			header ? `the calculated column "${header}"` : "a calculated column",
		);
	} else if (brokenCalculated.length > 1) {
		parts.push(`${brokenCalculated.length} calculated columns`);
	}
	const verb = total === 1 ? "has an error" : "have errors";
	return `Preview paused — ${parts.join(" and ")} ${verb} on this case list. Click the marked item to fix it.`;
}
