import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	comparisonObjectConstraint,
	type Expression,
	term,
} from "@/lib/domain/expression";
import { KIND_BUILDERS } from "./cards/comparisonSeed";
import {
	reseedValueForConstraint,
	resolveExpressionType,
} from "./cards/reseed";
import { defaultCaseTypeValue } from "./caseTypeValueModel";
import type { PredicateEditContext } from "./editorSchemas";
/** The case types the compared row can be: the editor's current row type,
 * which a relation's condition has already rebound to its destination. */
export function possibleRowCaseTypes(
	ctx: Pick<PredicateEditContext, "currentCaseType">,
): readonly string[] {
	return ctx.currentCaseType === "" ? [] : [ctx.currentCaseType];
}

/** Whether a comparison's subject is "Case type", the row's own type, whose
 * value is a case type picked from the catalog. */
export function comparesCaseType(left: Expression): boolean {
	return left.kind === "term" && left.term.kind === "case-row-type";
}

function caseTypeValue(name: string): Expression {
	return term({ kind: "case-type", caseType: name });
}

export function replaceComparisonSubject(
	value: ExpressionOfKind<"eq" | "neq" | "gt" | "gte" | "lt" | "lte">,
	left: Expression,
	ctx: PredicateEditContext,
): Expression {
	const builder = KIND_BUILDERS[value.kind];
	// "Case type" compares with a case type of the app: a value that names
	// none, such as a blank literal, is refused, so the value moves with it.
	if (comparesCaseType(left)) {
		if (value.right.kind === "term" && value.right.term.kind === "case-type")
			return builder(left, value.right);
		const name = defaultCaseTypeValue(
			ctx.caseTypes.map((type) => type.name),
			possibleRowCaseTypes(ctx),
		);
		return builder(
			left,
			name === undefined ? value.right : caseTypeValue(name),
		);
	}
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
