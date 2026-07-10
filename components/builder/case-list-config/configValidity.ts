// components/builder/case-list-config/configValidity.ts
//
// Pure whole-config validity for `CaseListConfig`. The magazine-era
// workspace aggregated validity from MOUNTED editors; the
// artifact-first workspace mounts at most one editor (the inspected
// entity), so the verdicts have to be derivable from the config
// alone. Callers pass the EFFECTIVE case types
// (`useEffectiveCaseTypes` — the same view the commit gate's
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
// TWO verdicts come out of the same walk, because they answer
// different questions:
//
//   - `caseListConfigErrorAreas` + `brokenColumnUuids` — "what should
//     the tab dots and in-canvas error marks flag": every finding,
//     including search-input problems and column-kind applicability
//     mismatches.
//   - `caseListPreviewObstacle` — "may the live preview run": ONLY
//     the ASTs the case-store SQL compiler actually consumes (the
//     filter + calculated-column expressions). An applicability
//     mismatch or a search-input problem never blanks the live table
//     — those rows still load and render fine; the marks + inspector
//     carry the signal. Pausing exists to keep an invalid AST out of
//     `compileExpression`, nothing more.

import type { CaseListConfig, CaseType, Uuid } from "@/lib/domain";
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
	let search = false;
	let list = false;
	let detail = false;

	const broken = brokenColumnUuids(config, caseTypes, currentCaseType);
	for (const col of config.columns) {
		if (!broken.has(col.uuid)) continue;
		// The list canvas renders every column (hidden ones dim), so a
		// broken column always badges the list tab; the detail tab is
		// badged only when the column participates there.
		list = true;
		if (col.visibleInDetail !== false) detail = true;
	}

	if (filterBroken(config, caseTypes, currentCaseType)) list = true;

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

/**
 * The columns the canvases mark as broken — a calculated column whose
 * expression fails the type check, or a property column whose kind
 * can't render the property's resolved type. This is the SAME
 * per-column judgment `caseListConfigErrorAreas` folds into the tab
 * dots, exposed by uuid so the list/detail canvases can put the mark
 * on the offending column itself ("errors marked on the tabs" must
 * point at something findable).
 */
export function brokenColumnUuids(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): ReadonlySet<Uuid> {
	const editCtx = { caseTypes, currentCaseType };
	const bareCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [],
		currentCaseType,
	};
	const broken = new Set<Uuid>();
	for (const col of config.columns) {
		const isBroken =
			col.kind === "calculated"
				? !checkValueExpression(col.expression, bareCtx).ok
				: !columnCardSchemas[col.kind].applicableForProperty(
						resolveColumnProperty(editCtx, col.field),
					);
		if (isBroken) broken.add(col.uuid);
	}
	return broken;
}

/**
 * Why the live preview can't run, or `null` when it can. Scoped to
 * the ASTs `loadCaseListPreviewAction` hands the case-store SQL
 * compiler — the filter and the calculated-column expressions; an
 * invalid one would throw at the SQL layer, so the preview pauses
 * with a message naming the thing to open. Everything else the
 * error-areas walk flags (search inputs, kind applicability) leaves
 * the live rows running.
 */
export function caseListPreviewObstacle(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): string | null {
	const bareCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [],
		currentCaseType,
	};
	const brokenCalculated = config.columns.filter(
		(col) =>
			col.kind === "calculated" &&
			!checkValueExpression(col.expression, bareCtx).ok,
	);
	const filterIsBroken = filterBroken(config, caseTypes, currentCaseType);

	if (brokenCalculated.length === 0 && !filterIsBroken) return null;

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
	const subject = parts.join(" and ");
	const verb =
		filterIsBroken && brokenCalculated.length === 0
			? "has an error"
			: brokenCalculated.length === 1 && !filterIsBroken
				? "has an error"
				: "have errors";
	return `Preview paused — ${subject} ${verb} on this case list. Click the marked item to fix it.`;
}

function filterBroken(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): boolean {
	if (config.filter === undefined) return false;
	const filterCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [...config.searchInputs],
		currentCaseType,
	};
	return !checkPredicate(config.filter, filterCtx).ok;
}

export function isCaseListConfigValid(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): boolean {
	const areas = caseListConfigErrorAreas(config, caseTypes, currentCaseType);
	return !areas.search && !areas.list && !areas.detail;
}
