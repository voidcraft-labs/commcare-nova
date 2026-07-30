/**
 * CommCare casedb/CSQL leaf for a Nova case-property name.
 *
 * Nova authors one canonical vocabulary. Casedb metadata stored as XML
 * attributes needs its `@` prefix.
 */

import { quoteIdentifier } from "./predicate/stringQuoting";

/** Standard case values stored as attributes on CommCare's `<case>` node. */
export const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

/** Emit the child/attribute path used by detail XPath and CSQL. */
export function emitCasePropertyWirePath(property: string): string {
	const identifier = quoteIdentifier(property);
	return RESERVED_CASE_ATTRIBUTES.has(property) ? `@${identifier}` : identifier;
}
