/** Walk authored expressions that CSQL emission evaluates on the device. */
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { walkSearchRuntimeValues } from "@/lib/domain/expression/searchRuntimeValues";
import { type Expression, isConditionArm } from "@/lib/domain/expression/types";
import { walkOnDeviceExpression } from "../validator/onDeviceCompatibility";
import { normalizeCsqlPredicate } from "./representability";

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
/** Native query clauses stay on the server; each non-native value runs
 * on-device (`searchRuntimeValues.ts`, the walk the checker shares). */
export function walkCsqlOnDeviceNodes(
	predicate: Expression,
	context: ExpressionContext,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	walkSearchRuntimeValues(
		normalizeCsqlPredicate(predicate),
		context,
		(value, valueContext) =>
			visitWholeOnDeviceExpression(value, valueContext, visitor),
	);
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
