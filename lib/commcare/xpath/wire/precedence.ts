import type { WireArithmetic, WireComparison, WireExpr } from "./tree";

/** Syntactic facts from a constructed expression, never from rendered text. */
export interface WireGrouping {
	readonly precedence: number;
	readonly logical?: "and" | "or";
}

export const ATOMIC_GROUPING: WireGrouping = { precedence: 9 };

export function operatorGrouping(
	op: WireComparison | WireArithmetic | "and" | "or",
): WireGrouping {
	switch (op) {
		case "or":
			return { precedence: 1, logical: op };
		case "and":
			return { precedence: 2, logical: op };
		case "=":
		case "!=":
			return { precedence: 3 };
		case "<":
		case "<=":
		case ">":
		case ">=":
			return { precedence: 4 };
		case "+":
		case "-":
			return { precedence: 5 };
		case "*":
		case "div":
		case "mod":
			return { precedence: 6 };
	}
}

export function wireGrouping(expr: WireExpr): WireGrouping {
	switch (expr.k) {
		case "expansion":
			return wireGrouping(expr.expr);
		case "or":
		case "and":
			return operatorGrouping(expr.k);
		case "cmp":
		case "arith":
			return operatorGrouping(expr.op);
		case "neg":
			return { precedence: 7 };
		case "num":
			return expr.value < 0 ? { precedence: 7 } : ATOMIC_GROUPING;
		case "path":
			return { precedence: 8 };
		default:
			return ATOMIC_GROUPING;
	}
}

export function needsWireGrouping(
	child: WireGrouping | undefined,
	parent: WireGrouping,
	right: boolean,
): boolean {
	if (child === undefined) return true;
	const sameLogical =
		parent.logical !== undefined && child.logical === parent.logical;
	return (
		child.precedence < parent.precedence ||
		(right && child.precedence === parent.precedence && !sameLogical)
	);
}
