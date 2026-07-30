// Pick the first meaningful, type-valid condition available in a scope.
// Structural predicates use this instead of assuming every case type owns a
// property. A relation-only schema can therefore still seed a real condition,
// while an entirely empty schema keeps those structures unavailable.

import { exists, type Predicate } from "@/lib/domain/predicate";
import { firstComparisonDefault } from "./cards/comparisonSeed";
import {
	caseDataInScope,
	type PredicateEditContext,
	relatedCaseDataInScope,
	tableRowInScope,
} from "./editorSchemas";
import { firstRelatedCasePath } from "./relationSeed";

/** Visible next step for optional nested-condition controls with no valid seed. */
export const CONDITION_SEED_UNAVAILABLE_REASON =
	"Add case information or choose another connection before adding a condition";

export function firstConditionSeed(
	ctx: PredicateEditContext,
): Predicate | undefined {
	/* A table-row scope has no valid placeholder identity. Its first seed is
	 * the active table's first admitted column, or the gesture is unavailable
	 * until the table owns a column. */
	if (tableRowInScope(ctx)) {
		return (ctx.tableScope?.columns.length ?? 0) > 0
			? firstComparisonDefault(ctx)
			: undefined;
	}
	// A global slot always has a seed: the session-value comparison the
	// comparison seeder builds for that scope (no case to read there).
	if (!caseDataInScope(ctx)) return firstComparisonDefault(ctx);

	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	if (current !== undefined && current.properties.length > 0) {
		return firstComparisonDefault(ctx);
	}

	// A scope confined to one already-chosen case has no connection to fall
	// back on, so an empty case type simply has nothing to compare yet.
	if (!relatedCaseDataInScope(ctx)) return undefined;

	const via = firstRelatedCasePath(ctx);
	return via === undefined ? undefined : exists(via);
}

export function hasConditionSeed(ctx: PredicateEditContext): boolean {
	return firstConditionSeed(ctx) !== undefined;
}
