/**
 * Pure CSQL value-expression capability classification.
 *
 * Validation and dialect walkers need this closed-set question without the
 * considerably larger CSQL emission pipeline. Keeping it in a dependency-free
 * leaf prevents client-side authoring validation from loading wire emitters it
 * never executes.
 */

import type { Expression } from "@/lib/domain/expression/types";

export function isNativeCsqlValueExpression(expr: Expression): boolean {
	switch (expr.kind) {
		case "term":
		case "today":
		case "now":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "date-add":
			return true;
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
			return false;
		default:
			return false;
	}
}
