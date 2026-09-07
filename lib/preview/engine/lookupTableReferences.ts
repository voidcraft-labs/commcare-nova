// Pure projections of lookup references used to choose each preview data snapshot.
import {
	extractLookupReferenceOccurrences,
	lookupReferenceTargetsFromOccurrences,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseListConfig, Uuid } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	mapExpressionAst,
	mapPredicateAst,
	type ValueExpression,
} from "@/lib/domain/predicate";

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
