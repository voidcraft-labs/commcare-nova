import type { Uuid } from "./uuid";
import type { XPathExpression } from "./xpath/ast";

/** Only a bare question reference can be a direct count. Hidden values and
 * other expressions need an integer calculation carrier. */
export function directRepeatCountReference(
	expression: XPathExpression,
	fields: Readonly<Record<string, { kind: string } | undefined>>,
): Uuid | undefined {
	const parts = expression.parts.filter(
		(part) => part.kind !== "text" || part.text.trim() !== "",
	);
	const part = parts.length === 1 ? parts[0] : undefined;
	if (part?.kind !== "field-ref" && part?.kind !== "path-ref") return undefined;
	return fields[part.uuid]?.kind === "hidden" ? undefined : part.uuid;
}
