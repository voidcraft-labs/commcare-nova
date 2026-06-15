// components/builder/case-list-config/configValidity.ts
//
// Pure whole-config validity for `CaseListConfig` — the gate the
// workspace's live preview sits behind. The magazine-era workspace
// aggregated validity from MOUNTED editors; the artifact-first
// workspace mounts at most one editor (the inspected entity), so the
// gate has to be derivable from the config alone.
//
// Each check mirrors the corresponding editor's own verdict source so
// the gate can't disagree with what the inspector shows:
//
//   - columns: the per-kind applicability predicate from
//     `columnEditorSchemas` (what `ColumnEditor` surfaces inline);
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
// An invalid verdict pauses the preview rather than letting a
// malformed AST reach the case-store compiler, where it would surface
// as a raw SQL-layer error arm.

import type { CaseListConfig, CaseType } from "@/lib/domain";
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

export function caseListConfigErrorAreas(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): CaseListConfigErrorAreas {
	const editCtx = { caseTypes, currentCaseType };
	const bareCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [],
		currentCaseType,
	};

	let search = false;
	let list = false;
	let detail = false;

	for (const col of config.columns) {
		const broken =
			col.kind === "calculated"
				? !checkValueExpression(col.expression, bareCtx).ok
				: !columnCardSchemas[col.kind].applicableForProperty(
						resolveColumnProperty(editCtx, col.field),
					);
		if (broken) {
			// The list canvas renders every column (hidden ones dim), so a
			// broken column always badges the list tab; the detail tab is
			// badged only when the column participates there.
			list = true;
			if (col.visibleInDetail !== false) detail = true;
		}
	}

	if (config.filter !== undefined) {
		const filterCtx: TypeContext = {
			caseTypes: [...caseTypes],
			knownInputs: [...config.searchInputs],
			currentCaseType,
		};
		if (!checkPredicate(config.filter, filterCtx).ok) list = true;
	}

	// An advanced predicate resolves `input(...)` against EVERY named row
	// — the full scope the validator's `moduleTypeContext` and the wire
	// emitter use. Hoisted out of the loop: it doesn't vary per row.
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

	return { search, list, detail };
}

export function isCaseListConfigValid(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): boolean {
	const areas = caseListConfigErrorAreas(config, caseTypes, currentCaseType);
	return !areas.search && !areas.list && !areas.detail;
}
