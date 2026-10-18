import type { TypingContext } from "./context";
import { scalarDataType, typeOf } from "./typeChecker";
import type { Expression } from "./types";
/** Runtime compilation uses the same inferred data axis as the commit gate. */
export function resolveNumericExpressionType(
	expression: Expression,
	context: TypingContext,
): "int" | "decimal" {
	const type = scalarDataType(typeOf(expression, context)?.data);
	if (type === "int" || type === "decimal") return type;
	throw new Error(
		`Arithmetic reached runtime compilation without its declared numeric type: ${String(type)}`,
	);
}
