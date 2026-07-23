/**
 * Dialect-state walk for AST nodes that a CSQL query evaluates on-device.
 *
 * A CSQL predicate is not one homogeneous runtime. Its query operators and
 * native value functions execute on the CCHQ server, while non-native
 * `ValueExpression` roots are emitted as JavaRosa XPath fragments inside the
 * outer `concat(...)` wrapper. Native value functions recurse argument by
 * argument, so a non-native argument switches only that subtree to on-device
 * execution. `count` is position-sensitive: a direct subcase count on a
 * comparison's left side becomes native `subcase-count(...)`; every other
 * count root is inlined wholly on-device.
 *
 * This walker mirrors that dispatch for compatibility validators. The native
 * value-function classification is imported from the expression emitter so a
 * whitelist change cannot make validation and wire emission disagree.
 */

import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import {
	walkExpressionNodes,
	walkExpressionPredicateNodes,
} from "@/lib/domain/predicate";
import { isNativeCsqlValueExpression } from "../expression/csqlEmitter";
import { normalizeCsqlPredicate } from "./csqlRepresentability";

export interface CsqlOnDeviceNodeVisitor {
	readonly visitPredicate?: (predicate: Predicate) => void;
	readonly visitExpression?: (expression: ValueExpression) => void;
}

type OperandPosition = "comparison-operand" | "value";

/** Visit only authored nodes that CSQL emission lowers through JavaRosa. */
export function walkCsqlOnDeviceNodes(
	predicate: Predicate,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	walkServerPredicate(normalizeCsqlPredicate(predicate), visitor);
}

function walkServerPredicate(
	predicate: Predicate,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
		case "multi-select-contains":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			walkServerOperand(predicate.left, "comparison-operand", visitor);
			walkServerOperand(predicate.right, "value", visitor);
			return;
		case "in":
		case "is-null":
		case "is-blank":
			walkServerOperand(predicate.left, "comparison-operand", visitor);
			return;
		case "between":
			walkServerOperand(predicate.left, "comparison-operand", visitor);
			if (predicate.lower !== undefined) {
				walkServerOperand(predicate.lower, "value", visitor);
			}
			if (predicate.upper !== undefined) {
				walkServerOperand(predicate.upper, "value", visitor);
			}
			return;
		case "match":
			walkServerOperand(predicate.value, "value", visitor);
			return;
		case "within-distance":
			walkServerOperand(predicate.center, "value", visitor);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				walkServerPredicate(clause, visitor);
			}
			return;
		case "not":
			walkServerPredicate(predicate.clause, visitor);
			return;
		case "when-input-present":
			// The generated outer `if(count(input), <csql>, ...)` is XPath,
			// but the authored clause still compiles into the server CSQL string.
			walkServerPredicate(predicate.clause, visitor);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				walkServerPredicate(predicate.where, visitor);
			}
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`walkCsqlOnDeviceNodes: unhandled Predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

function walkServerOperand(
	expression: ValueExpression,
	position: OperandPosition,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	if (expression.kind === "count") {
		if (
			position === "comparison-operand" &&
			expression.via.kind === "subcase"
		) {
			if (expression.where !== undefined) {
				walkServerPredicate(expression.where, visitor);
			}
			return;
		}
		visitWholeOnDeviceExpression(expression, visitor);
		return;
	}

	if (!isNativeCsqlValueExpression(expression)) {
		visitWholeOnDeviceExpression(expression, visitor);
		return;
	}

	// Native CSQL functions recurse per argument. A native child remains on the
	// server; a non-native child switches that complete subtree to on-device.
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			walkServerOperand(expression.value, "value", visitor);
			return;
		case "date-add":
			walkServerOperand(expression.date, "value", visitor);
			walkServerOperand(expression.quantity, "value", visitor);
			return;
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "format-date":
		case "table-lookup":
			// Guarded by `isNativeCsqlValueExpression`; retaining these arms
			// makes a whitelist change a compile-visible decision here.
			throw new Error(
				`walkCsqlOnDeviceNodes: non-native expression '${expression.kind}' reached the native CSQL branch`,
			);
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`walkCsqlOnDeviceNodes: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

function visitWholeOnDeviceExpression(
	expression: ValueExpression,
	visitor: CsqlOnDeviceNodeVisitor,
): void {
	if (visitor.visitExpression !== undefined) {
		walkExpressionNodes(expression, visitor.visitExpression);
	}
	if (visitor.visitPredicate !== undefined) {
		walkExpressionPredicateNodes(expression, visitor.visitPredicate);
	}
}
