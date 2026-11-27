import { isStandardCaseListProperty } from "../standardCaseProperties";
import type { Expression, PropertyRef } from "./types";

/** The text comparison whose left side follows the listed record's direct host. */
export function directHostTextEquality(
	expression: Expression,
): PropertyRef | undefined {
	if (
		expression.kind !== "eq" ||
		expression.left.kind !== "term" ||
		expression.right.kind !== "term"
	)
		return undefined;
	const property = expression.left.term;
	const literal = expression.right.term;
	if (
		property.kind !== "prop" ||
		property.readReached !== true ||
		property.via?.kind !== "ancestor" ||
		property.via.via.length !== 1 ||
		property.via.via[0].identifier !== "host" ||
		property.property === "name" ||
		isStandardCaseListProperty(property.property) ||
		literal.kind !== "literal" ||
		typeof literal.value !== "string" ||
		literal.value.trim() === ""
	)
		return undefined;
	return property;
}
