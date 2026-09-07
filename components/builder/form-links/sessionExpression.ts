import type { XPathExpression } from "@/lib/domain";

/** A parsed reference to the form that will already be closed when this runs. */
export function readsForm(expression: XPathExpression): boolean {
	return expression.parts.some(
		(part) => part.kind === "field-ref" || part.kind === "path-ref",
	);
}
