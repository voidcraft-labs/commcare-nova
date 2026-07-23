/**
 * Context-free temporal result inference shared by AST consumers.
 *
 * This is deliberately narrower than the canonical type checker: it proves a
 * type only from a discriminator, explicit literal metadata, or branch
 * wrappers whose non-null results all agree. Property and input terms remain
 * unresolved without a `TypeContext`. `neutral` models a literal null: it
 * does not decide the result type of `coalesce`, `if`, or `switch`.
 */

import type { ResolvedType } from "./typeChecker";
import type { ValueExpression } from "./types";

export type TemporalType = "date" | "datetime";
export type StructuralTemporalType = TemporalType | "neutral";

export function asTemporalType(
	type: ResolvedType | undefined,
): TemporalType | undefined {
	return type === "date" || type === "datetime" ? type : undefined;
}

export function inferStructuralTemporalType(
	expression: ValueExpression,
): StructuralTemporalType | undefined {
	switch (expression.kind) {
		case "today":
		case "date-coerce":
			return "date";
		case "now":
		case "datetime-coerce":
			return "datetime";
		case "date-add":
			return inferStructuralTemporalType(expression.date);
		case "term":
			if (expression.term.kind !== "literal") return undefined;
			if (expression.term.value === null) return "neutral";
			return asTemporalType(expression.term.data_type);
		case "if":
			return agreedTemporalType([
				inferStructuralTemporalType(expression.then),
				inferStructuralTemporalType(expression.else),
			]);
		case "switch":
			return agreedTemporalType([
				...expression.cases.map((entry) =>
					inferStructuralTemporalType(entry.then),
				),
				inferStructuralTemporalType(expression.fallback),
			]);
		case "coalesce":
			return agreedTemporalType(
				expression.values.map(inferStructuralTemporalType),
			);
		case "arith":
		case "concat":
		case "count":
		case "double":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
		case "unwrap-list":
			return undefined;
		default: {
			const _exhaustive: never = expression;
			return _exhaustive;
		}
	}
}

function agreedTemporalType(
	types: readonly (StructuralTemporalType | undefined)[],
): StructuralTemporalType | undefined {
	if (types.length === 0 || types.some((type) => type === undefined)) {
		return undefined;
	}
	const concrete = types.filter(
		(type): type is TemporalType => type === "date" || type === "datetime",
	);
	if (concrete.length === 0) return "neutral";
	const first = concrete[0];
	return concrete.every((type) => type === first) ? first : undefined;
}
