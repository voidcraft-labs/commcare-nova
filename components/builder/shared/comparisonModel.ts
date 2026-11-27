import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	type ComparisonKind,
	comparisonObjectConstraint,
	type Expression,
	term,
} from "@/lib/domain/expression";
import {
	searchChoiceColumnOrder,
	searchSessionTextOrder,
} from "@/lib/domain/expression/ruleSets";
import { KIND_BUILDERS } from "./cards/comparisonSeed";
import {
	reseedValueForConstraint,
	resolveExpressionType,
} from "./cards/reseed";
import { defaultCaseTypeValue } from "./caseTypeValueModel";
import {
	retargetSelectionValue,
	staticSelectSubject,
} from "./choiceValueModel";
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

export function comparesNumericallyOrderedSearchText(
	ctx: PredicateEditContext,
	kind: ComparisonKind,
	left: Expression | undefined,
	right: Expression | undefined,
): boolean {
	if (left === undefined || right === undefined) return false;
	if (ctx.expressionContext.profile.searchTextDefault === true)
		return searchSessionTextOrder(kind, left, right);
	return (
		ctx.expressionContext.slot.slot === "search_input_options" &&
		searchChoiceColumnOrder(kind, left, right) &&
		resolveExpressionType(left, ctx) === "text" &&
		resolveExpressionType(right, ctx) === "text"
	);
}

/** The comparison's value retargeted at a new subject, when it is a choice
 * or a written value that names one of the subject's choices: undefined
 * leaves the ordinary reseed to decide, so a written value that names no
 * choice stays as written. */
function selectionValueFor(
	left: Expression,
	right: Expression,
	ctx: PredicateEditContext,
): Expression | undefined {
	if (right.kind !== "term") return undefined;
	const item = right.term;
	if (item.kind !== "literal" && item.kind !== "choice") return undefined;
	const next = retargetSelectionValue(
		item,
		staticSelectSubject(left, ctx.expressionContext),
		ctx.expressionContext,
	);
	return next === item ? undefined : term(next);
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
	if (comparesNumericallyOrderedSearchText(ctx, value.kind, left, value.right))
		return builder(left, value.right);
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
	// Opposite a question with written choices the value is one of them, and
	// a choice of a question no longer compared becomes its current value,
	// so the comparison keeps what it compares with.
	const selection = selectionValueFor(left, value.right, ctx);
	if (selection !== undefined) return builder(left, selection);
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
