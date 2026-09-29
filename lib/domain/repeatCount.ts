import type { Uuid } from "./uuid";
import type { XPathExpression } from "./xpath/ast";

/** Only a bare identity reference can be a direct count. Other expressions
 * need their own calculated value, including secondary-instance paths. */
export function directRepeatCountReference(
	expression: XPathExpression,
): Uuid | undefined {
	const parts = expression.parts.filter(
		(part) => part.kind !== "text" || part.text.trim() !== "",
	);
	const part = parts.length === 1 ? parts[0] : undefined;
	return part?.kind === "field-ref" || part?.kind === "path-ref"
		? part.uuid
		: undefined;
}
