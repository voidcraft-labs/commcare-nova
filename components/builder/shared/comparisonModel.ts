import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	comparisonObjectConstraint,
	type Expression,
} from "@/lib/domain/expression";
import { KIND_BUILDERS } from "./cards/comparisonSeed";
import {
	reseedValueForConstraint,
	resolveExpressionType,
} from "./cards/reseed";
import type { PredicateEditContext } from "./editorSchemas";
export function replaceComparisonSubject(
	value: ExpressionOfKind<"eq" | "neq" | "gt" | "gte" | "lt" | "lte">,
	left: Expression,
	ctx: PredicateEditContext,
): Expression {
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
