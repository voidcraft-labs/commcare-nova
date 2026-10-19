/** Target restrictions for expressions evaluated by CommCare Core. */
import {
	type ExpressionChild,
	expressionChildren,
} from "@/lib/domain/expression/children";
import {
	activeRowScope,
	type ExpressionContext,
} from "@/lib/domain/expression/context";
import { canonicalizeRelationPath } from "@/lib/domain/expression/normalizeRelationEvaluationScopes";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import {
	expressionChildContext,
	scalarDataType,
	typeOf,
} from "@/lib/domain/expression/typeChecker";
import {
	type Expression,
	isConditionArm,
	isExpression,
	type PropertyRef,
	type Term,
} from "@/lib/domain/expression/types";

export type OnDeviceScalarExpressionIssue = {
	readonly reason: "multi-valued-relation-read";
	readonly property: PropertyRef;
};
export type OnDeviceDateAddIssue = {
	readonly reason: "calendar-interval" | "datetime-base";
	readonly expression: Extract<Expression, { kind: "date-add" }>;
};

/** Whole-carrier validation owns operand validity; this adds only target limits. */
export function onDeviceDateAddIssue(
	expression: Expression,
	context: ExpressionContext,
): OnDeviceDateAddIssue | undefined {
	if (expression.kind !== "date-add") return undefined;
	if (expression.interval === "months" || expression.interval === "years")
		return { expression, reason: "calendar-interval" };
	return scalarDataType(typeOf(expression.date, context)?.data) === "datetime"
		? { expression, reason: "datetime-base" }
		: undefined;
}

/** A structural walk with the checker's lexical row and form-node contexts. */
export function walkOnDeviceExpression(
	expression: Expression,
	context: ExpressionContext,
	visit: (node: Expression, context: ExpressionContext) => void,
): void {
	function walk(node: Expression | Term, ctx: ExpressionContext): void {
		if (isExpression(node)) visit(node, ctx);
		for (const child of expressionChildren(node)) {
			if (child.kind === "relation") continue;
			walk(child.value, expressionChildContext(node, child, ctx));
		}
	}
	walk(expression, context);
}

export function findOnDeviceDateAddIssue(
	expression: Expression,
	context: ExpressionContext,
): OnDeviceDateAddIssue | undefined {
	let issue: OnDeviceDateAddIssue | undefined;
	walkOnDeviceExpression(expression, context, (node, lexicalContext) => {
		issue ??= onDeviceDateAddIssue(node, lexicalContext);
	});
	return issue;
}

/** The same unified walk serves old named predicate callers until their imports move. */
export function findOnDeviceDateAddIssueInPredicate(
	expression: Expression,
	context: ExpressionContext,
): OnDeviceDateAddIssue | undefined {
	return findOnDeviceDateAddIssue(expression, context);
}

/** Predicates and explicit aggregates own their row-set semantics separately. */
export function findOnDeviceScalarExpressionIssue(
	expression: Expression,
	context: ExpressionContext,
): OnDeviceScalarExpressionIssue | undefined {
	const property = findMultiValuedScalarPropertyRead(expression, context);
	return property === undefined
		? undefined
		: { reason: "multi-valued-relation-read", property };
}
function findMultiValuedScalarPropertyRead(
	expression: Expression,
	context: ExpressionContext,
): PropertyRef | undefined {
	if (
		isConditionArm(expression) ||
		expression.kind === "count" ||
		expression.kind === "table-lookup"
	)
		return undefined;
	if (expression.kind === "term") {
		const term = expression.term;
		if (term.kind !== "prop" || term.via === undefined) return undefined;
		const row = activeRowScope(context);
		const caseRow =
			row?.kind === "case"
				? row
				: row?.kind === "table"
					? row.capturedCase
					: undefined;
		const origin = caseRow?.caseType ?? term.caseType;
		// The checker owns an unavailable relationship; target checks must not
		// throw while presenting its refusal. A qualifier names the destination.
		if (
			!resolveRelationDestination(term.via, origin, context.facts.caseTypes).ok
		)
			return undefined;
		const relation = canonicalizeRelationPath(term.via, {
			caseTypes: context.facts.caseTypes,
			currentCaseType: origin,
		});
		return relation.via.kind === "subcase" ||
			relation.via.kind === "any-relation"
			? term
			: undefined;
	}
	for (const child of expressionChildren(expression)) {
		if (!isScalarChild(child)) continue;
		const property = findMultiValuedScalarPropertyRead(
			child.value,
			expressionChildContext(expression, child, context),
		);
		if (property !== undefined) return property;
	}
	return undefined;
}
function isScalarChild(
	child: ExpressionChild,
): child is Extract<ExpressionChild, { kind: "expression" }> {
	return child.kind === "expression" && !isConditionArm(child.value);
}
