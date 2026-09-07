/** Classify a count's original carrier so snapshotting preserves its native
 * conversion. Path values retain their lexical string for IntegerData.cast;
 * other expressions use an xsd:int snapshot and Core's numeric narrowing.
 * All emitted jr:count attributes refer to generated snapshot nodes. */
import { isPathExpression } from "@/lib/commcare/xform/pathExpression";

/** The expression has already passed form-context projection. This classifier
 * is shared with other Core XPathPathExpr boundaries; it is not an evaluator. */
export function isCountReferencePath(expr: string): boolean {
	return isPathExpression(expr);
}
