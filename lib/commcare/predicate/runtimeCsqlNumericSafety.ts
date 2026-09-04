/** Numeric constraints imposed by CCHQ's server-side case-search parser. */

import type { Uuid } from "@/lib/domain";
import type {
	Predicate,
	SearchInputDecl,
	ValueExpression,
} from "@/lib/domain/predicate";

export type RuntimeCsqlNumericConstraint =
	| "whole-number"
	| "nonnegative-whole-number";

export type CsqlNumericValueClassification =
	| { readonly kind: "static-valid"; readonly value: number }
	| {
			readonly kind: "runtime-input";
			readonly inputName: string;
			readonly inputUuid: Uuid;
			readonly inputXPath: string;
	  }
	| { readonly kind: "unsupported" };

/** CCHQ calendar shifts accept integral quantities only. */
export function classifyCalendarDateAddQuantity(
	expression: ValueExpression,
	knownInputs: readonly SearchInputDecl[] = [],
): CsqlNumericValueClassification {
	const known = staticallyKnownNumber(expression);
	if (known !== undefined && Number.isInteger(known)) {
		return { kind: "static-valid", value: known };
	}
	const inputUuid = numericInputUuid(expression, false);
	const inputName = knownInputs.find((input) => input.uuid === inputUuid)?.name;
	if (inputUuid !== undefined && inputName !== undefined) {
		return {
			kind: "runtime-input",
			inputUuid,
			inputName,
			inputXPath: searchInputXPath(inputName),
		};
	}
	return { kind: "unsupported" };
}

/** Structural admission used before a runtime-name projection is needed. */
export function isRepresentableCalendarDateAddQuantity(
	expression: ValueExpression,
): boolean {
	const known = staticallyKnownNumber(expression);
	return (
		(known !== undefined && Number.isInteger(known)) ||
		numericInputUuid(expression, false) !== undefined
	);
}

/** CCHQ's subcase-count parser calls `int(...)`; Nova forbids truncation. */
export function classifySubcaseCountBound(
	expression: ValueExpression,
	knownInputs: readonly SearchInputDecl[] = [],
): CsqlNumericValueClassification {
	const known = staticallyKnownNumber(expression);
	if (known !== undefined && Number.isInteger(known) && known >= 0) {
		return { kind: "static-valid", value: known };
	}
	const inputUuid = numericInputUuid(expression, true);
	const inputName = knownInputs.find((input) => input.uuid === inputUuid)?.name;
	if (inputUuid !== undefined && inputName !== undefined) {
		return {
			kind: "runtime-input",
			inputUuid,
			inputName,
			inputXPath: searchInputXPath(inputName),
		};
	}
	return { kind: "unsupported" };
}

/** Structural admission used before a runtime-name projection is needed. */
export function isRepresentableSubcaseCountBound(
	expression: ValueExpression,
): boolean {
	const known = staticallyKnownNumber(expression);
	return (
		(known !== undefined && Number.isInteger(known) && known >= 0) ||
		numericInputUuid(expression, true) !== undefined
	);
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
	knownInputs: readonly SearchInputDecl[] = [],
): ReadonlyMap<string, RuntimeCsqlNumericConstraint> {
	const constraints = new Map<string, RuntimeCsqlNumericConstraint>();
	walkQueryPredicate(predicate, constraints, knownInputs);
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
	knownInputs: readonly SearchInputDecl[],
): void {
	const classification = classifySubcaseCountBound(expression, knownInputs);
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
	knownInputs: readonly SearchInputDecl[],
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
				addSubcaseBoundConstraint(predicate.right, out, knownInputs);
			} else {
				walkRuntimeValue(predicate.right, "csql", out, knownInputs);
			}
			return;
		case "in":
		case "is-blank":
		case "matches-pattern":
			return;
		case "between":
			if (isSubcaseCount(predicate.left)) {
				if (predicate.lower !== undefined)
					addSubcaseBoundConstraint(predicate.lower, out, knownInputs);
				if (predicate.upper !== undefined)
					addSubcaseBoundConstraint(predicate.upper, out, knownInputs);
			} else {
				if (predicate.lower !== undefined)
					walkRuntimeValue(predicate.lower, "csql", out, knownInputs);
				if (predicate.upper !== undefined)
					walkRuntimeValue(predicate.upper, "csql", out, knownInputs);
			}
			return;
		case "match":
			walkRuntimeValue(predicate.value, "csql", out, knownInputs);
			return;
		case "within-distance":
			walkRuntimeValue(predicate.center, "csql", out, knownInputs);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				walkQueryPredicate(clause, out, knownInputs);
			}
			return;
		case "not":
			walkQueryPredicate(predicate.clause, out, knownInputs);
			return;
		case "when-input-present":
			walkQueryPredicate(predicate.clause, out, knownInputs);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined)
				walkQueryPredicate(predicate.where, out, knownInputs);
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
	knownInputs: readonly SearchInputDecl[],
): void {
	const childDialect: RuntimeDialect =
		dialect === "csql" && isNativeCsqlExpression(expression)
			? "csql"
			: "on-device";
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-add": {
			if (
				dialect === "csql" &&
				(expression.interval === "months" || expression.interval === "years")
			) {
				const classification = classifyCalendarDateAddQuantity(
					expression.quantity,
					knownInputs,
				);
				if (classification.kind === "runtime-input") {
					addConstraint(out, classification.inputName, "whole-number");
				}
			}
			walkRuntimeValue(expression.date, childDialect, out, knownInputs);
			walkRuntimeValue(expression.quantity, childDialect, out, knownInputs);
			return;
		}
		case "date-coerce":
		case "datetime-coerce":
		case "double":
			walkRuntimeValue(expression.value, childDialect, out, knownInputs);
			return;
		case "arith":
			walkRuntimeValue(expression.left, "on-device", out, knownInputs);
			walkRuntimeValue(expression.right, "on-device", out, knownInputs);
			return;
		case "concat":
			for (const part of expression.parts)
				walkRuntimeValue(part, "on-device", out, knownInputs);
			return;
		case "coalesce":
			for (const value of expression.values)
				walkRuntimeValue(value, "on-device", out, knownInputs);
			return;
		case "if":
			walkRuntimeValue(expression.then, "on-device", out, knownInputs);
			walkRuntimeValue(expression.else, "on-device", out, knownInputs);
			return;
		case "switch":
			walkRuntimeValue(expression.on, "on-device", out, knownInputs);
			for (const entry of expression.cases)
				walkRuntimeValue(entry.then, "on-device", out, knownInputs);
			walkRuntimeValue(expression.fallback, "on-device", out, knownInputs);
			return;
		case "count":
			return;
		case "table-lookup":
			// Lookup values execute on-device against the emitted fixture before
			// the result is interpolated into CSQL. The table-row predicate owns
			// no case-search numeric prompt constraint.
			return;
		case "format-date":
			walkRuntimeValue(expression.date, "on-device", out, knownInputs);
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
		default: {
			const _exhaustive: never = expression;
			throw new Error(`Unhandled ValueExpression ${String(_exhaustive)}`);
		}
	}
}

function numericInputUuid(
	expression: ValueExpression,
	allowDirectInput: boolean,
): Uuid | undefined {
	if (
		expression.kind === "double" &&
		expression.value.kind === "term" &&
		expression.value.term.kind === "input"
	) {
		return expression.value.term.searchInputUuid;
	}
	if (
		allowDirectInput &&
		expression.kind === "term" &&
		expression.term.kind === "input"
	) {
		return expression.term.searchInputUuid;
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
