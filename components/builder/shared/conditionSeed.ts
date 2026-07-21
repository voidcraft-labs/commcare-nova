// Pick the first meaningful, type-valid condition available in a scope.
// Structural predicates use this instead of assuming every case type owns a
// property. A relation-only schema can therefore still seed a real condition,
// while an entirely empty schema keeps those structures unavailable.

import { exists, type Predicate } from "@/lib/domain/predicate";
import { firstComparisonDefault } from "./cards/comparisonSeed";
import { caseDataInScope, type PredicateEditContext } from "./editorSchemas";
import { firstRelatedCasePath } from "./relationSeed";

/** Visible next step for optional nested-condition controls with no valid seed. */
export const CONDITION_SEED_UNAVAILABLE_REASON =
	"Add case information or choose another connection before adding a condition";

export function firstConditionSeed(
	ctx: PredicateEditContext,
): Predicate | undefined {
	// A global slot always has a seed: the session-value comparison the
	// comparison seeder builds for that scope (no case to read there).
	if (!caseDataInScope(ctx)) return firstComparisonDefault(ctx);

	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	if (current !== undefined && current.properties.length > 0) {
		return firstComparisonDefault(ctx);
	}

	const via = firstRelatedCasePath(ctx);
	return via === undefined ? undefined : exists(via);
}

export function hasConditionSeed(ctx: PredicateEditContext): boolean {
	return firstConditionSeed(ctx) !== undefined;
}
