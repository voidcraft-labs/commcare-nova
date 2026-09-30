/**
 * Context-free temporal result inference shared by AST consumers.
 *
 * This is deliberately narrower than the canonical type checker: it proves a
 * type only from a discriminator, explicit literal metadata, or branch
 * wrappers whose non-null results all agree. An optional term resolver supplies
 * contextual property/input types; without it those terms remain unresolved. `neutral` models a literal null: it
 * does not decide the result type of `coalesce`, `if`, or `switch`.
 */

import { isCalendarCaseProperty } from "../standardCaseProperties";
import {
	type CheckError,
	checkExpression,
	type ResolvedType,
	type TypeContext,
} from "./typeChecker";
import type { Term, ValueExpression } from "./types";

export type TemporalType = "date" | "datetime";
export type StructuralTemporalType = TemporalType | "neutral";

export function asTemporalType(
	type: ResolvedType | undefined,
): TemporalType | undefined {
	return type === "date" || type === "datetime" ? type : undefined;
}

export function inferStructuralTemporalType(
	expression: ValueExpression,
	resolveTerm?: (term: Term) => StructuralTemporalType | undefined,
): StructuralTemporalType | undefined {
	switch (expression.kind) {
		case "today":
		case "date-coerce":
			return "date";
		case "now":
		case "datetime-coerce":
			return "datetime";
		case "date-add":
			return inferStructuralTemporalType(expression.date, resolveTerm);
		case "term":
			if (expression.term.kind !== "literal")
				return resolveTerm?.(expression.term);
			if (expression.term.value === null) return "neutral";
			return asTemporalType(expression.term.data_type);
		case "if":
			return agreedTemporalType([
				inferStructuralTemporalType(expression.then, resolveTerm),
				inferStructuralTemporalType(expression.else, resolveTerm),
			]);
		case "switch":
			return agreedTemporalType([
				...expression.cases.map((entry) =>
					inferStructuralTemporalType(entry.then, resolveTerm),
				),
				inferStructuralTemporalType(expression.fallback, resolveTerm),
			]);
		case "coalesce":
			return agreedTemporalType(
				expression.values.map((value) =>
					inferStructuralTemporalType(value, resolveTerm),
				),
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

/** Results/Details read metadata dates from the native case instance. Keep
 * authored admission types when validating the expression; only infer the
 * resulting value shape through its value branches. A datetime comparison in
 * an if-condition must not invalidate an otherwise admitted date-valued result.
 * Mixed date/datetime branches keep their authored datetime result type. */
export function resolveCaseListTemporalType(
	expression: ValueExpression,
	context: TypeContext,
): TemporalType | undefined {
	const errors: CheckError[] = [];
	const authored = checkExpression(expression, context, errors, []);
	if (errors.length !== 0) return undefined;
	const portable = inferStructuralTemporalType(expression, (term) => {
		if (term.kind === "prop" && isCalendarCaseProperty(term.property))
			return "date";
		return asTemporalType(
			checkExpression({ kind: "term", term }, context, [], []),
		);
	});
	return portable === "date" || portable === "datetime"
		? portable
		: asTemporalType(authored);
}
