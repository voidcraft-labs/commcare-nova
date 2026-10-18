/** Walk authored expressions that CSQL emission evaluates on the device. */
import { expressionChildren } from "@/lib/domain/expression/children";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { expressionChildContext } from "@/lib/domain/expression/typeChecker";
import {
	type Expression,
	isConditionArm,
	isRelationPath,
} from "@/lib/domain/expression/types";
import { isNativeCsqlValueExpression } from "../expression/csqlCapabilities";
import { walkOnDeviceExpression } from "../expression/onDeviceCompatibility";
import { normalizeCsqlPredicate } from "./csqlRepresentability";

export interface CsqlOnDeviceNodeVisitor {
	readonly visitPredicate?: (
		predicate: Expression,
		context: ExpressionContext,
	) => void;
	readonly visitExpression?: (
		expression: Expression,
		context: ExpressionContext,
	) => void;
}
type OperandPosition = "comparison-operand" | "value";

/** Native query clauses stay on the server; each non-native value runs on-device. */
export function walkCsqlOnDeviceNodes(
	predicate: Expression,
	context: ExpressionContext,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	walkServerPredicate(normalizeCsqlPredicate(predicate), context, visitor);
}

function walkServerPredicate(
	predicate: Expression,
	context: ExpressionContext,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	if (!isConditionArm(predicate)) {
		visitWholeOnDeviceExpression(predicate, context, visitor);
		return;
	}
	for (const child of expressionChildren(predicate)) {
		if (child.kind !== "expression") continue;
		const childContext = expressionChildContext(predicate, child, context);
		if (
			predicate.kind === "and" ||
			predicate.kind === "or" ||
			predicate.kind === "not" ||
			predicate.kind === "when-input-present" ||
			predicate.kind === "exists" ||
			predicate.kind === "missing"
		) {
			walkServerPredicate(child.value, childContext, visitor);
			continue;
		}
		const position =
			child.role.kind === "operand" && child.role.slot === "left"
				? "comparison-operand"
				: "value";
		walkServerOperand(child.value, position, childContext, visitor);
	}
}

function walkServerOperand(
	expression: Expression,
	position: OperandPosition,
	context: ExpressionContext,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	if (
		expression.kind === "count" &&
		isRelationPath(expression.via) &&
		expression.via.kind === "subcase" &&
		position === "comparison-operand"
	) {
		for (const child of expressionChildren(expression)) {
			if (
				child.kind === "expression" &&
				child.role.kind === "operand" &&
				child.role.slot === "where"
			)
				walkServerPredicate(
					child.value,
					expressionChildContext(expression, child, context),
					visitor,
				);
		}
		return;
	}
	if (!isNativeCsqlValueExpression(expression)) {
		visitWholeOnDeviceExpression(expression, context, visitor);
		return;
	}
	for (const child of expressionChildren(expression)) {
		if (child.kind === "expression")
			walkServerOperand(
				child.value,
				"value",
				expressionChildContext(expression, child, context),
				visitor,
			);
	}
}

function visitWholeOnDeviceExpression(
	expression: Expression,
	context: ExpressionContext,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	walkOnDeviceExpression(expression, context, (node, lexicalContext) => {
		visitor.visitExpression?.(node, lexicalContext);
		if (isConditionArm(node)) visitor.visitPredicate?.(node, lexicalContext);
	});
}
