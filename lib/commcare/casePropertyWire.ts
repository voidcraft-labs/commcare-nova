/**
 * CommCare casedb/CSQL leaf for a Nova case-property name.
 *
 * Nova authors one canonical vocabulary, while older blueprints may still
 * carry CCHQ's detail-screen aliases. Both must compile to the same runtime
 * node, and casedb metadata stored as XML attributes needs its `@` prefix.
 */

import { canonicalCasePropertyName } from "@/lib/domain";
import { quoteIdentifier } from "./predicate/stringQuoting";

/** Standard case values stored as attributes on CommCare's `<case>` node. */
export const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

/** Emit the canonical child/attribute path used by detail XPath and CSQL. */
export function emitCasePropertyWirePath(property: string): string {
	const canonical = canonicalCasePropertyName(property);
	const identifier = quoteIdentifier(canonical);
	return RESERVED_CASE_ATTRIBUTES.has(canonical)
		? `@${identifier}`
		: identifier;
}
