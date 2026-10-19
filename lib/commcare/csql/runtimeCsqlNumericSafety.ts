import type { SearchInputDecl } from "@/lib/domain/expression/context";
import { isServerSearchValue } from "@/lib/domain/expression/searchRuntimeValues";
import { isConditionArm } from "@/lib/domain/expression/types";
/** Numeric constraints imposed by CCHQ's server-side case-search parser. */

import type { Uuid } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { w } from "../xpath/wire/builders";
import type { SearchInputInstanceId } from "../xpath/wire/fromExpression";
import {
	STANDALONE_SEARCH_INPUT_INSTANCE_ID,
	searchInputInstance,
} from "../xpath/wire/instances";
import type { WireExpr } from "../xpath/wire/tree";

export type RuntimeCsqlNumericConstraint =
	| "whole-number"
	| "nonnegative-whole-number";

export type CsqlNumericValueClassification =
	| { readonly kind: "static-valid"; readonly value: number }
	| {
			readonly kind: "runtime-input";
			readonly inputName: string;
			readonly inputUuid: Uuid;
			readonly inputXPath: WireExpr;
	  }
	| { readonly kind: "unsupported" };

/** CCHQ calendar shifts accept integral quantities only. */
export function classifyCalendarDateAddQuantity(
	expression: Expression,
	knownInputs: readonly SearchInputDecl[] = [],
	searchInputInstanceId?: SearchInputInstanceId,
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
			inputXPath: searchInputXPath(inputName, searchInputInstanceId),
		};
	}
	return { kind: "unsupported" };
}

/** Structural admission used before a runtime-name projection is needed. */
export function isRepresentableCalendarDateAddQuantity(
	expression: Expression,
): boolean {
	const known = staticallyKnownNumber(expression);
	return (
		(known !== undefined && Number.isInteger(known)) ||
		numericInputUuid(expression, false) !== undefined
	);
}

/** CCHQ's subcase-count parser calls `int(...)`; Nova forbids truncation. */
export function classifySubcaseCountBound(
	expression: Expression,
	knownInputs: readonly SearchInputDecl[] = [],
	searchInputInstanceId?: SearchInputInstanceId,
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
			inputXPath: searchInputXPath(inputName, searchInputInstanceId),
		};
	}
	return { kind: "unsupported" };
}

/** Structural admission used before a runtime-name projection is needed. */
export function isRepresentableSubcaseCountBound(
	expression: Expression,
): boolean {
	const known = staticallyKnownNumber(expression);
	return (
		(known !== undefined && Number.isInteger(known) && known >= 0) ||
		numericInputUuid(expression, true) !== undefined
	);
}

export function invalidWholeNumberXPath(xpath: WireExpr): WireExpr {
	const number = w.call("number", [xpath]);
	return w.not(w.eq(number, w.call("floor", [number])));
}

export function invalidNonnegativeWholeNumberXPath(xpath: WireExpr): WireExpr {
	const number = w.call("number", [xpath]);
	return w.not(
		w.and(w.eq(number, w.call("floor", [number])), w.gte(number, w.num(0))),
	);
}

export function promptWholeNumberTest(
	constraint: RuntimeCsqlNumericConstraint,
): WireExpr {
	const value = w.context();
	const number = w.call("number", [value]);
	const whole = w.eq(number, w.call("floor", [number]));
	return w.or(
		w.eq(value, w.str("")),
		constraint === "whole-number"
			? whole
			: w.and(whole, w.gte(number, w.num(0))),
	);
}

/** Numeric prompt requirements from the exact normalized CSQL predicate. */
export function collectRuntimeCsqlNumericInputConstraints(
	predicate: Expression,
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
	expression: Expression,
	out: Map<string, RuntimeCsqlNumericConstraint>,
	knownInputs: readonly SearchInputDecl[],
): void {
	const classification = classifySubcaseCountBound(expression, knownInputs);
	if (classification.kind === "runtime-input") {
		addConstraint(out, classification.inputName, "nonnegative-whole-number");
	}
}

function isSubcaseCount(expression: Expression): boolean {
	return expression.kind === "count" && expression.via.kind === "subcase";
}

function walkQueryPredicate(
	predicate: Expression,
	out: Map<string, RuntimeCsqlNumericConstraint>,
	knownInputs: readonly SearchInputDecl[],
): void {
	if (!isConditionArm(predicate)) return;
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
			throw new Error(`Unhandled Expression ${String(_exhaustive)}`);
		}
	}
}

type RuntimeDialect = "csql" | "on-device";

function walkRuntimeValue(
	expression: Expression,
	dialect: RuntimeDialect,
	out: Map<string, RuntimeCsqlNumericConstraint>,
	knownInputs: readonly SearchInputDecl[],
): void {
	const childDialect: RuntimeDialect =
		dialect === "csql" && isServerSearchValue(expression)
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
		default:
			// The remaining expressions execute wholly on-device and impose no
			// server calendar-shift or subcase-count input constraint.
			return;
	}
}

function numericInputUuid(
	expression: Expression,
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

function staticallyKnownNumber(expression: Expression): number | undefined {
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

function searchInputXPath(
	name: string,
	searchInputInstanceId: SearchInputInstanceId | undefined,
): WireExpr {
	return w.instance(
		searchInputInstance(
			searchInputInstanceId ?? STANDALONE_SEARCH_INPUT_INSTANCE_ID,
		),
		[
			w.step("input"),
			w.step("field", [w.eq(w.context([w.attr("name")]), w.str(name))]),
		],
	);
}
