import type { SearchInputDecl } from "@/lib/domain/expression/context";
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
