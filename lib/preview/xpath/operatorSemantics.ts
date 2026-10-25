import { compareEqual, compareRelational, toNumber } from "./coerce";
import type { DayNumberEpoch } from "./coreDays";
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
	epoch: DayNumberEpoch,
): XPathRuntimeValue {
	switch (type) {
		case "AddExpr":
			return toNumber(left, epoch) + toNumber(right, epoch);
		case "SubtractExpr":
			return toNumber(left, epoch) - toNumber(right, epoch);
		case "MultiplyExpr":
			return toNumber(left, epoch) * toNumber(right, epoch);
		case "DivideExpr":
			return toNumber(left, epoch) / toNumber(right, epoch);
		case "ModulusExpr":
			return toNumber(left, epoch) % toNumber(right, epoch);
		case "EqualsExpr":
			return compareEqual(left, right, epoch);
		case "NotEqualsExpr":
			return !compareEqual(left, right, epoch);
		case "LessThanExpr":
			return compareRelational(left, right, "<", epoch);
		case "LessEqualExpr":
			return compareRelational(left, right, "<=", epoch);
		case "GreaterThanExpr":
			return compareRelational(left, right, ">", epoch);
		case "GreaterEqualExpr":
			return compareRelational(left, right, ">=", epoch);
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
