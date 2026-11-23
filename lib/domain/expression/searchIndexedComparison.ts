import { isValidCalendarDate } from "../calendarDate";
import {
	isStandardCaseListProperty,
	SYSTEM_DATETIME_CASE_PROPERTIES,
} from "../standardCaseProperties";
import { isReadableTemporalValue } from "../temporalValues";
import { literalShape } from "./ruleSets";
import type { Expression } from "./types";

/** HQ first attempts a decimal floating point number, then a date or an
 * instant. A bare time and arbitrary text do not define an ordering. */
export function searchIndexedValueKind(
	value: string,
): "number" | "date" | "datetime" | undefined {
	if (
		/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) &&
		Number.isFinite(Number(value))
	)
		return "number";
	const shape = literalShape(value);
	if (shape?.type === "date" && isValidCalendarDate(value)) return "date";
	if (
		shape?.type === "datetime" &&
		isValidCalendarDate(value.slice(0, 10)) &&
		isReadableTemporalValue("datetime", value)
	)
		return "datetime";
}

/** The native index compares the property’s stored spelling. Ordering
 * chooses the numeric or date index from the value on the right. */
export function searchIndexedComparison(
	equality: boolean,
	left: Expression,
	leftType: string | undefined,
	right: Expression,
	rightType: string | undefined,
): "number" | "date" | "datetime" | "exact-text" | "runtime" | undefined {
	if (left.kind !== "term" || left.term.kind !== "prop" || !leftType) return;
	const prop = left.term.property;
	if (
		isStandardCaseListProperty(prop) ||
		SYSTEM_DATETIME_CASE_PROPERTIES.has(prop)
	)
		return;
	const value =
		right.kind === "term" && right.term.kind === "literal"
			? right.term.value
			: undefined;
	if (equality) {
		if (leftType === "datetime" && rightType === "text") return "exact-text";
		return;
	}
	if (leftType !== "text" && leftType !== "time") return;
	if (rightType === "int" || rightType === "decimal") return "number";
	if (rightType === "date" || rightType === "datetime") return rightType;
	if (typeof value === "string") return searchIndexedValueKind(value);
	if (right.kind !== "term" || right.term.kind !== "literal") {
		if (rightType === "text" || rightType === "time") return "runtime";
	}
}
