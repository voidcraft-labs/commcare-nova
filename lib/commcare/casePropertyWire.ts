/**
 * CommCare casedb/CSQL leaf for a Nova case-property name.
 *
 * Nova authors one canonical vocabulary. Casedb metadata stored as XML
 * attributes needs its `@` prefix.
 */

import { CASE_NODE_ATTRIBUTE_PROPERTIES } from "@/lib/domain";
import { quoteIdentifier } from "./predicate/stringQuoting";

/** Standard case values stored as attributes on CommCare's `<case>` node. The
 *  set itself is domain knowledge, because authoring surfaces withhold shapes
 *  that read a property by bare name; this is its wire spelling. */
export const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> =
	CASE_NODE_ATTRIBUTE_PROPERTIES;

/** Emit the child/attribute path used by detail XPath and CSQL. */
export function emitCasePropertyWirePath(property: string): string {
	const identifier = quoteIdentifier(property);
	return RESERVED_CASE_ATTRIBUTES.has(property) ? `@${identifier}` : identifier;
}
