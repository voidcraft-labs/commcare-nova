/**
 * Detects a common XPath authoring mistake: a bare word used where a string
 * literal was intended. An expression like `no` parses cleanly as a single
 * `NameTest` node referencing a data path named "no", not as the string
 * `"no"` — almost always an author error that would otherwise slip through
 * to CommCare and produce a silently wrong lookup.
 *
 * Returns the offending word (trimmed) when the expression is exactly one
 * parse-clean `NameTest`, otherwise `null`. Expressions with multiple
 * top-level nodes, parse errors, literals, or any structure other than a
 * bare name are left alone — callers get a definite "yes, this is an
 * unquoted literal" signal or nothing at all.
 */

import { parser } from "./parser";
import { NameTest } from "./parser.terms";

export function detectUnquotedStringLiteral(expr: string): string | null {
	const trimmed = expr.trim();
	if (!trimmed) return null;

	const tree = parser.parse(trimmed);
	const top = tree.topNode;
	const child = top.firstChild;

	/*
	 * Require exactly one top-level child — multi-expression inputs
	 * (e.g. `foo + 1`) aren't bare identifiers even if one branch is.
	 */
	if (!child || child.nextSibling) return null;
	if (child.type.id !== NameTest) return null;

	/*
	 * Reject parse errors anywhere in the tree. A `NameTest` next to an
	 * error node means the parser recovered past a real mistake; flagging
	 * that as "unquoted literal" would mask the true cause.
	 */
	let hasError = false;
	tree.iterate({
		enter(node) {
			if (node.type.isError) hasError = true;
		},
	});
	if (hasError) return null;

	return trimmed;
}
