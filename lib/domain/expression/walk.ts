import { expressionChildren } from "./children";
import {
	type CheckPath,
	type ConditionArm,
	type Expression,
	isConditionArm,
	isRelationPath,
	type PropertyRef,
	type RelationPath,
	type SearchInputRef,
	type Term,
} from "./types";

export {
	type ExpressionChild,
	type ExpressionChildRole,
	type ExpressionNode,
	expressionChildPath,
	expressionChildren,
} from "./children";
export interface ExpressionVisitor {
	readonly visitExpression?: (expression: Expression, path: CheckPath) => void;
	readonly visitTerm?: (term: Term, path: CheckPath) => void;
	readonly visitRelation?: (relation: RelationPath, path: CheckPath) => void;
}
/** Pre-order. Each term, including direct leaf slots and path filters, is visited once. */
export function walkExpression(
	expression: Expression,
	visitor: ExpressionVisitor,
	path: CheckPath = [],
): void {
	visitor.visitExpression?.(expression, path);
	walkChildren(expression, visitor, path);
}
/** Pre-order over one term and what it holds, as {@link walkExpression}. */
export function walkTerm(
	term: Term,
	visitor: ExpressionVisitor,
	path: CheckPath,
): void {
	visitor.visitTerm?.(term, path);
	walkChildren(term, visitor, path);
}
function walkChildren(
	node: Expression | Term,
	visitor: ExpressionVisitor,
	path: CheckPath,
): void {
	for (const child of expressionChildren(node, path)) {
		switch (child.kind) {
			case "expression":
				walkExpression(child.value, visitor, child.path);
				break;
			case "term":
				walkTerm(child.value, visitor, child.path);
				break;
			case "relation":
				visitor.visitRelation?.(child.value, child.path);
				break;
		}
	}
}
export function walkExpressionNodes(
	expression: Expression,
	visit: (expression: Expression, path: CheckPath) => void,
): void {
	walkExpression(expression, { visitExpression: visit });
}
export function walkExpressionTerms(
	expression: Expression,
	visit: (term: Term, path: CheckPath) => void,
): void {
	walkExpression(expression, { visitTerm: visit });
}
export function walkConditionArms(
	expression: Expression,
	visit: (condition: ConditionArm, path: CheckPath) => void,
): void {
	walkExpression(expression, {
		visitExpression: (node, path) => {
			if (isConditionArm(node)) visit(node, path);
		},
	});
}
export function walkInputRefs(
	expression: Expression,
	visit: (input: SearchInputRef, path: CheckPath) => void,
): void {
	walkExpression(expression, {
		visitTerm: (term, path) => {
			if (term.kind === "input") visit(term, path);
		},
	});
}
export function walkPropertyRefs(
	expression: Expression,
	visit: (property: PropertyRef, path: CheckPath) => void,
): void {
	walkExpression(expression, {
		visitTerm: (term, path) => {
			if (term.kind === "prop") visit(term, path);
		},
	});
}
export function expressionReferencesSearchInput(
	expression: Expression,
	uuid: SearchInputRef["searchInputUuid"],
): boolean {
	let found = false;
	walkInputRefs(expression, (ref) => {
		if (ref.searchInputUuid === uuid) found = true;
	});
	return found;
}
export function expressionReferencesAnySearchInput(
	expression: Expression,
): boolean {
	let found = false;
	walkInputRefs(expression, () => {
		found = true;
	});
	return found;
}
export function expressionReadsCaseData(expression: Expression): boolean {
	let found = false;
	walkExpression(expression, {
		visitTerm: (term) => {
			if (
				[
					"prop",
					"form-case",
					"owner-location-at-level",
					"case-index",
					"case-row-type",
				].includes(term.kind)
			)
				found = true;
		},
		visitExpression: (node) => {
			if (
				node.kind === "cases" ||
				node.kind === "exists" ||
				node.kind === "missing" ||
				(node.kind === "count" && isRelationPath(node.via))
			)
				found = true;
		},
	});
	return found;
}
export function expressionReadsRelatedCaseData(
	expression: Expression,
): boolean {
	let found = false;
	walkExpression(expression, {
		visitRelation: (relation) => {
			if (relation.kind !== "self") found = true;
		},
	});
	return found;
}
export function expressionUsesPattern(expression: Expression): boolean {
	let found = false;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "matches-pattern") found = true;
	});
	return found;
}
/** Unanswered input guards disappear before their trigger can be read. */
export function substituteUnansweredSearchInputs(
	expression: Expression,
): Expression {
	if (!expressionReferencesAnySearchInput(expression)) return expression;
	const substituted = structuredClone(expression);
	walkExpression(substituted, {
		visitExpression: (node) => {
			if (node.kind !== "when-input-present") return;
			const mutable = node as unknown as Record<string, unknown>;
			delete mutable.input;
			delete mutable.clause;
			mutable.kind = "match-all";
		},
		visitTerm: (term) => {
			if (term.kind !== "input") return;
			const mutable = term as unknown as Record<string, unknown>;
			delete mutable.searchInputUuid;
			mutable.kind = "literal";
			mutable.value = "";
		},
	});
	return substituted;
}
