import { isValidCalendarDate } from "../calendarDate";
import {
	isStandardCaseListProperty,
	SYSTEM_DATETIME_CASE_PROPERTIES,
} from "../standardCaseProperties";
import { isReadableTemporalValue } from "../temporalValues";
import { canonicalIntegerText, literalShape } from "./ruleSets";
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

/** The property types whose equality with text HQ's search tests on the
 * stored text (`es/case_search.py::case_property_query` →
 * `exact_case_property_text_query`, whatever the property's type), where
 * Nova's own rules would type the two values apart. A date and time takes it
 * as well; text and a choice already compare as text. */
const STORED_TEXT_EQUALITY_TYPES: ReadonlySet<string> = new Set([
	"date",
	"time",
	"int",
	"decimal",
]);

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
		// HQ sends an integer literal unchanged to the exact text index of a
		// custom date. A legacy value can be "3" without being a calendar day.
		if (
			leftType === "date" &&
			rightType === "int" &&
			typeof value === "number" &&
			canonicalIntegerText(String(value)) !== undefined
		)
			return "exact-text";
		if (rightType !== "text") return;
		if (leftType === "datetime") return "exact-text";
		if (!STORED_TEXT_EQUALITY_TYPES.has(leftType)) return;
		// A whole number written as text keeps Nova's own comparison of the
		// two numbers (`ruleSets.ts::coercedEquality`), which the device reads
		// the same way.
		if (
			leftType === "int" &&
			typeof value === "string" &&
			canonicalIntegerText(value) !== undefined
		)
			return;
		return "exact-text";
	}
	// A literal number orders stored numeric values in HQ’s numeric index.
	// A calendar date has no numeric index value.
	if (
		leftType === "date" &&
		(rightType === "int" || rightType === "decimal") &&
		typeof value === "number" &&
		Number.isFinite(value)
	)
		return "number";
	if (leftType !== "text" && leftType !== "time") return;
	if (rightType === "int" || rightType === "decimal") return "number";
	if (rightType === "date" || rightType === "datetime") return rightType;
	if (typeof value === "string") return searchIndexedValueKind(value);
	// A worker's text converts when the search runs, or HQ refuses the
	// search there. A time of day never converts: `float()` refuses it, and
	// so do Django's `parse_date` and `parse_datetime`
	// (`comparison.py::_parse_date_or_datetime`), so HQ refuses every such
	// search with `CaseFilterError`, and the comparison is typed by Nova's own
	// rules, which refuse to order a time.
	if (right.kind !== "term" || right.term.kind !== "literal") {
		if (rightType === "text") return "runtime";
	}
}
