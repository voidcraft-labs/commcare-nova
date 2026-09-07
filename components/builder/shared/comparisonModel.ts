import {
	comparisonObjectConstraint,
	type Predicate,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { KIND_BUILDERS } from "./cards/comparisonSeed";
import {
	reseedValueForConstraint,
	resolveExpressionType,
} from "./cards/reseed";
import type { PredicateEditContext } from "./editorSchemas";
export function replaceComparisonSubject(
	value: Extract<
		Predicate,
		{ kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" }
	>,
	left: ValueExpression,
	ctx: PredicateEditContext,
): Predicate {
	const builder = KIND_BUILDERS[value.kind];
	const accepts = comparisonObjectConstraint(
		value.kind,
		resolveExpressionType(left, ctx),
	).accepts;
	if (accepts === "any") return builder(left, value.right);
	const rightType = resolveExpressionType(value.right, ctx);
	const right =
		rightType !== undefined && !accepts.has(rightType)
			? reseedValueForConstraint(value.right, accepts)
			: value.right;
	return builder(left, right);
}
