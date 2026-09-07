import { checkExpression, type TypeContext } from "./typeChecker";
import type { ValueExpression } from "./types";

/**
 * Runtime compilers preserve the arithmetic type admitted by the doc gate.
 * This projects the result type, not admission: unrelated condition/operation
 * scope errors do not erase a known branch type. The owning gate already
 * validates those scopes; missing numeric operand metadata still fails here.
 */
export function resolveNumericExpressionType(
	expression: ValueExpression,
	context: TypeContext,
): "int" | "decimal" {
	const errors: Parameters<typeof checkExpression>[2] = [];
	const type = checkExpression(expression, context, errors, []);
	if (type === "int" || type === "decimal") return type;
	throw new Error(
		`Arithmetic reached runtime compilation without its declared numeric type: ${errors.map((error) => error.message).join("; ") || String(type)}`,
	);
}
