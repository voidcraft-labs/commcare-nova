import type { Uuid } from "../uuid";
import type { Expression } from "./types";

function directField(expression: Expression): Uuid | undefined {
	if (expression.kind !== "term" || expression.term.kind !== "field")
		return undefined;
	const field = expression.term;
	return field.filters === undefined &&
		field.role === undefined &&
		field.spelling === undefined
		? field.uuid
		: undefined;
}

/** A raw form calculation can add a whole-number answer to a Text answer.
 * CommCare writes the resulting number as untyped text, with NaN as blank. */
export function wholeNumberAndTextSum(
	expression: Expression,
	fieldType: (uuid: Uuid) => string | undefined,
): readonly [wholeNumber: Uuid, text: Uuid] | undefined {
	if (expression.kind !== "arith" || expression.op !== "+") return undefined;
	const left = directField(expression.left);
	const right = directField(expression.right);
	return left !== undefined &&
		right !== undefined &&
		fieldType(left) === "int" &&
		fieldType(right) === "text"
		? [left, right]
		: undefined;
}
