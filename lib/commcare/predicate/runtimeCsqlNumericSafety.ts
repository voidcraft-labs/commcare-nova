/** Numeric constraints imposed by CCHQ's server-side case-search parser. */

import type { Predicate, ValueExpression } from "@/lib/domain/predicate";

export type RuntimeCsqlNumericConstraint =
	| "whole-number"
	| "nonnegative-whole-number";

export type CsqlNumericValueClassification =
	| { readonly kind: "static-valid"; readonly value: number }
	| {
			readonly kind: "runtime-input";
			readonly inputName: string;
			readonly inputXPath: string;
	  }
	| { readonly kind: "unsupported" };

/** CCHQ calendar shifts accept integral quantities only. */
export function classifyCalendarDateAddQuantity(
	expression: ValueExpression,
): CsqlNumericValueClassification {
	const known = staticallyKnownNumber(expression);
	if (known !== undefined && Number.isInteger(known)) {
		return { kind: "static-valid", value: known };
	}
	const inputName = numericInputName(expression, false);
	if (inputName !== undefined) {
		return {
			kind: "runtime-input",
			inputName,
			inputXPath: searchInputXPath(inputName),
		};
	}
	return { kind: "unsupported" };
}

/** CCHQ's subcase-count parser calls `int(...)`; Nova forbids truncation. */
export function classifySubcaseCountBound(
	expression: ValueExpression,
): CsqlNumericValueClassification {
	const known = staticallyKnownNumber(expression);
	if (known !== undefined && Number.isInteger(known) && known >= 0) {
		return { kind: "static-valid", value: known };
	}
	const inputName = numericInputName(expression, true);
	if (inputName !== undefined) {
		return {
			kind: "runtime-input",
			inputName,
			inputXPath: searchInputXPath(inputName),
		};
	}
	return { kind: "unsupported" };
}

export function invalidWholeNumberXPath(xpath: string): string {
	return `not(number(${xpath}) = floor(number(${xpath})))`;
}

export function invalidNonnegativeWholeNumberXPath(xpath: string): string {
	return `not(number(${xpath}) = floor(number(${xpath})) and number(${xpath}) >= 0)`;
}

export function promptWholeNumberTest(
	constraint: RuntimeCsqlNumericConstraint,
): string {
	return constraint === "whole-number"
		? ". = '' or number(.) = floor(number(.))"
		: ". = '' or (number(.) = floor(number(.)) and number(.) >= 0)";
}

/** Numeric prompt requirements from the exact normalized CSQL predicate. */
export function collectRuntimeCsqlNumericInputConstraints(
	predicate: Predicate,
): ReadonlyMap<string, RuntimeCsqlNumericConstraint> {
	const constraints = new Map<string, RuntimeCsqlNumericConstraint>();
	walkQueryPredicate(predicate, constraints);
	return constraints;
}

function addConstraint(
	out: Map<string, RuntimeCsqlNumericConstraint>,
	name: string,
	constraint: RuntimeCsqlNumericConstraint,
): void {
	if (
		constraint === "nonnegative-whole-number" ||
		out.get(name) === undefined
	) {
		out.set(name, constraint);
	}
}

function addSubcaseBoundConstraint(
	expression: ValueExpression,
	out: Map<string, RuntimeCsqlNumericConstraint>,
): void {
	const classification = classifySubcaseCountBound(expression);
	if (classification.kind === "runtime-input") {
		addConstraint(out, classification.inputName, "nonnegative-whole-number");
	}
}

function isSubcaseCount(expression: ValueExpression): boolean {
	return expression.kind === "count" && expression.via.kind === "subcase";
}

function walkQueryPredicate(
	predicate: Predicate,
	out: Map<string, RuntimeCsqlNumericConstraint>,
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
			if (isSubcaseCount(predicate.left)) {
				addSubcaseBoundConstraint(predicate.right, out);
			} else {
				walkRuntimeValue(predicate.right, "csql", out);
			}
			return;
		case "in":
		case "is-null":
		case "is-blank":
			return;
		case "between":
			if (isSubcaseCount(predicate.left)) {
				if (predicate.lower !== undefined)
					addSubcaseBoundConstraint(predicate.lower, out);
				if (predicate.upper !== undefined)
					addSubcaseBoundConstraint(predicate.upper, out);
			} else {
				if (predicate.lower !== undefined)
					walkRuntimeValue(predicate.lower, "csql", out);
				if (predicate.upper !== undefined)
					walkRuntimeValue(predicate.upper, "csql", out);
			}
			return;
		case "match":
			walkRuntimeValue(predicate.value, "csql", out);
			return;
		case "within-distance":
			walkRuntimeValue(predicate.center, "csql", out);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) walkQueryPredicate(clause, out);
			return;
		case "not":
			walkQueryPredicate(predicate.clause, out);
			return;
		case "when-input-present":
			walkQueryPredicate(predicate.clause, out);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined)
				walkQueryPredicate(predicate.where, out);
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(`Unhandled Predicate ${String(_exhaustive)}`);
		}
	}
}

type RuntimeDialect = "csql" | "on-device";

function walkRuntimeValue(
	expression: ValueExpression,
	dialect: RuntimeDialect,
	out: Map<string, RuntimeCsqlNumericConstraint>,
): void {
	const childDialect: RuntimeDialect =
		dialect === "csql" && isNativeCsqlExpression(expression)
			? "csql"
			: "on-device";
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
			return;
		case "date-add": {
			if (
				dialect === "csql" &&
				(expression.interval === "months" || expression.interval === "years")
			) {
				const classification = classifyCalendarDateAddQuantity(
					expression.quantity,
				);
				if (classification.kind === "runtime-input") {
					addConstraint(out, classification.inputName, "whole-number");
				}
			}
			walkRuntimeValue(expression.date, childDialect, out);
			walkRuntimeValue(expression.quantity, childDialect, out);
			return;
		}
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			walkRuntimeValue(expression.value, childDialect, out);
			return;
		case "arith":
			walkRuntimeValue(expression.left, "on-device", out);
			walkRuntimeValue(expression.right, "on-device", out);
			return;
		case "concat":
			for (const part of expression.parts)
				walkRuntimeValue(part, "on-device", out);
			return;
		case "coalesce":
			for (const value of expression.values)
				walkRuntimeValue(value, "on-device", out);
			return;
		case "if":
			walkRuntimeValue(expression.then, "on-device", out);
			walkRuntimeValue(expression.else, "on-device", out);
			return;
		case "switch":
			walkRuntimeValue(expression.on, "on-device", out);
			for (const entry of expression.cases)
				walkRuntimeValue(entry.then, "on-device", out);
			walkRuntimeValue(expression.fallback, "on-device", out);
			return;
		case "count":
			return;
		case "format-date":
			walkRuntimeValue(expression.date, "on-device", out);
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(`Unhandled ValueExpression ${String(_exhaustive)}`);
		}
	}
}

function isNativeCsqlExpression(expression: ValueExpression): boolean {
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			return true;
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
			return false;
		default: {
			const _exhaustive: never = expression;
			throw new Error(`Unhandled ValueExpression ${String(_exhaustive)}`);
		}
	}
}

function numericInputName(
	expression: ValueExpression,
	allowDirectInput: boolean,
): string | undefined {
	if (
		expression.kind === "double" &&
		expression.value.kind === "term" &&
		expression.value.term.kind === "input"
	) {
		return expression.value.term.name;
	}
	if (
		allowDirectInput &&
		expression.kind === "term" &&
		expression.term.kind === "input"
	) {
		return expression.term.name;
	}
	return undefined;
}

function staticallyKnownNumber(
	expression: ValueExpression,
): number | undefined {
	if (expression.kind === "term" && expression.term.kind === "literal") {
		return finiteNumber(expression.term.value);
	}
	if (expression.kind === "double") {
		return staticallyKnownNumber(expression.value);
	}
	return undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function searchInputXPath(name: string): string {
	return `instance('search-input:results')/input/field[@name='${name}']`;
}
