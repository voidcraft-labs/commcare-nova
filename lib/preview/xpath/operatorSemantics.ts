import { compareEqual, compareRelational, toNumber } from "./coerce";
import type { XPathRuntimeValue } from "./runtimeValues";

const XPATH_BINARY_OPERATIONS = new Set([
	"AddExpr",
	"SubtractExpr",
	"MultiplyExpr",
	"DivideExpr",
	"ModulusExpr",
	"EqualsExpr",
	"NotEqualsExpr",
	"LessThanExpr",
	"LessEqualExpr",
	"GreaterThanExpr",
	"GreaterEqualExpr",
]);

export type XPathBinaryOperation =
	| "AddExpr"
	| "SubtractExpr"
	| "MultiplyExpr"
	| "DivideExpr"
	| "ModulusExpr"
	| "EqualsExpr"
	| "NotEqualsExpr"
	| "LessThanExpr"
	| "LessEqualExpr"
	| "GreaterThanExpr"
	| "GreaterEqualExpr";

export function isXPathBinaryOperation(
	type: string,
): type is XPathBinaryOperation {
	return XPATH_BINARY_OPERATIONS.has(type);
}

/** Shared by synchronous and asynchronous traversal so awaiting an operand
 * cannot change the operation applied after both operands are available.
 *
 * The coercers deliberately call XPathNodeset.unpack(): pinned JavaRosa does
 * not implement XPath 1.0's pairwise nodeset comparisons. A valid empty set
 * becomes blank, a singleton becomes its typed value, and a multi-node or
 * invalid set throws before equality, comparison, or arithmetic proceeds. */
export function applyXPathBinaryOperation(
	type: XPathBinaryOperation,
	left: XPathRuntimeValue,
	right: XPathRuntimeValue,
): XPathRuntimeValue {
	switch (type) {
		case "AddExpr":
			return toNumber(left) + toNumber(right);
		case "SubtractExpr":
			return toNumber(left) - toNumber(right);
		case "MultiplyExpr":
			return toNumber(left) * toNumber(right);
		case "DivideExpr":
			return toNumber(left) / toNumber(right);
		case "ModulusExpr":
			return toNumber(left) % toNumber(right);
		case "EqualsExpr":
			return compareEqual(left, right);
		case "NotEqualsExpr":
			return !compareEqual(left, right);
		case "LessThanExpr":
			return compareRelational(left, right, "<");
		case "LessEqualExpr":
			return compareRelational(left, right, "<=");
		case "GreaterThanExpr":
			return compareRelational(left, right, ">");
		case "GreaterEqualExpr":
			return compareRelational(left, right, ">=");
	}
}

export function missingXPathBinaryOperand(
	type: XPathBinaryOperation,
): XPathRuntimeValue {
	return type.endsWith("EqualsExpr") ||
		type.startsWith("Less") ||
		type.startsWith("Greater")
		? false
		: Number.NaN;
}
