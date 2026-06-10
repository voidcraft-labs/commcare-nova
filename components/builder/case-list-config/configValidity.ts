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
//     `searchInputResolution` plus per-row default-expression /
//     advanced-predicate checks against sibling-scoped known inputs —
//     exactly the editors `SearchInputEditor` mounts.
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
	computeKnownInputsForRow,
	expectedTypeForDefault,
	resolveRows,
	rowHasStructuralError,
} from "./searchInputResolution";

export function isCaseListConfigValid(
	config: CaseListConfig,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): boolean {
	const editCtx = { caseTypes, currentCaseType };
	const bareCtx: TypeContext = {
		caseTypes: [...caseTypes],
		knownInputs: [],
		currentCaseType,
	};

	for (const col of config.columns) {
		if (col.kind === "calculated") {
			if (!checkValueExpression(col.expression, bareCtx).ok) return false;
			continue;
		}
		const property = resolveColumnProperty(editCtx, col.field);
		if (!columnCardSchemas[col.kind].applicableForProperty(property)) {
			return false;
		}
	}

	if (config.filter !== undefined) {
		const filterCtx: TypeContext = {
			caseTypes: [...caseTypes],
			knownInputs: [...config.searchInputs],
			currentCaseType,
		};
		if (!checkPredicate(config.filter, filterCtx).ok) return false;
	}

	const resolved = resolveRows(config.searchInputs, caseTypes, currentCaseType);
	for (let i = 0; i < config.searchInputs.length; i++) {
		const row = config.searchInputs[i];
		const rowResolved = resolved[i];
		if (row === undefined || rowResolved === undefined) continue;
		if (rowHasStructuralError(rowResolved)) return false;

		const rowCtx: TypeContext = {
			caseTypes: [...caseTypes],
			knownInputs: [
				...computeKnownInputsForRow(
					config.searchInputs,
					i,
					caseTypes,
					currentCaseType,
				),
			],
			currentCaseType,
		};
		if (row.default !== undefined) {
			const verdict = checkValueExpression(
				row.default,
				rowCtx,
				expectedTypeForDefault(row.type),
			);
			if (!verdict.ok) return false;
		}
		if (row.kind === "advanced") {
			if (!checkPredicate(row.predicate, rowCtx).ok) return false;
		}
	}

	return true;
}
