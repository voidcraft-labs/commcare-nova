import { RESERVED_XFORM_NODE_PREFIX } from "../constants";
import { parser } from "../xpath/parser";
import type { FormPath } from "./formPath";

/** HQ generates untyped case-update binds. Reading a date-valued question into
 * one wraps it as DateData and loses the clock. A sibling text value preserves
 * the full instant on both HQ-regenerated and directly emitted submissions. */
export function datetimeCaseValueName(fieldId: string): string {
	return `${RESERVED_XFORM_NODE_PREFIX}datetime_${fieldId}`;
}

export function datetimeCaseValuePath(path: FormPath): FormPath {
	const last = path.segments().at(-1);
	if (last?.kind !== "element")
		throw new Error("A datetime answer must have an element path.");
	return path.parent().child(datetimeCaseValueName(last.name));
}

/**
 * The one spelling of a datetime case value, written on an untyped node: the
 * field's sibling text value here, and every Save to Case leaf that writes a
 * datetime property (`caseOps.ts`). HQ's form builder writes a Save to Case
 * row's bind with no `type`, so a typed leaf loses its clock on the first
 * save; this calculate keeps the instant on an untyped node, with the
 * device's offset and milliseconds. A value that is already a string is
 * parsed and printed again in the device's zone.
 */
export function datetimeCaseValueExpression(expression: string): string {
	// Core format-date(node-set) passes through toDate(), which rounds a
	// typed Date to midnight. coalesce unpacks the selected value first.
	return `if(${equalityOperand(expression)} = '', '', format-date(coalesce(${expression}, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`;
}

/**
 * `expression` as the left operand of `=`. Only `and` and `or` bind more
 * loosely than `=`, so an expression whose outermost operator is one of them
 * is parenthesized; every other expression reads the same bare, which keeps
 * a path's spelling unchanged. Structure is read through the Lezer grammar.
 */
function equalityOperand(expression: string): string {
	const outermost = parser.parse(expression).topNode.firstChild;
	return outermost?.name === "AndExpr" || outermost?.name === "OrExpr"
		? `(${expression})`
		: expression;
}

export function datetimeCaseValueCalculate(path: FormPath): string {
	return datetimeCaseValueExpression(path.toXPath());
}
