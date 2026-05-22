/**
 * Lezer-backed extraction of the secondary-instance ids an XPath expression
 * references via `instance('<id>')`.
 *
 * The suite oracle (`validator/suiteOracle.ts`) needs to know which
 * `<instance>` declarations every wire-emitted XPath depends on, so it can
 * assert each one is declared on the enclosing `<entry>` / `<remote-request>`.
 * CommCare's runtime resolves an `instance('foo')` reference through
 * `EvaluationContext.resolveReference`, which throws `XPathMissingInstanceException`
 * at evaluation time when no matching instance is in scope
 * (`commcare-core/.../org/javarosa/core/model/condition/EvaluationContext.java::
 * resolveReference`). That throw is parse-clean and runtime-fatal — exactly the
 * Category-2 gap the oracle owns.
 *
 * Structural, not textual. `instance('x')` is an XPath function call whose
 * single argument is a string literal; a substring scan would mis-handle a
 * literal that merely contains the word `instance` or nested quotes. The only
 * faithful classifier is the same Lezer grammar Nova ships for every other
 * XPath decision — the project rule is to never regex-parse XPath structure.
 * This walks the parse tree for `Invoke` nodes whose `FunctionName` is
 * `instance` and reads the first `StringLiteral` argument's unquoted value.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

/**
 * Collect every secondary-instance id an expression references through
 * `instance('<id>')`. Returns an empty set when the expression is empty,
 * unparseable, or references no instance — a malformed expression's *parse*
 * failure is the concern of the surrounding PATH/ANY classifiers, not this
 * extractor, so an unparseable input simply contributes no instance refs here.
 *
 * The id is the literal text between the argument's quotes, unescaped of the
 * XPath string-literal doubling convention (`''` → `'`). CommCare instance ids
 * never carry quotes in practice (`casedb`, `search-input:results`, etc.), but
 * the unescape keeps the extractor faithful to the grammar rather than assuming
 * a quote-free id space.
 */
export function collectInstanceRefs(expr: string): Set<string> {
	const ids = new Set<string>();
	const trimmed = expr.trim();
	if (!trimmed) return ids;

	const tree = parser.parse(trimmed);
	const cursor = tree.cursor();
	do {
		// An `instance(...)` call surfaces as an `Invoke` whose first child is a
		// `FunctionName` reading `instance`. Match on that pair rather than on raw
		// text so a NameTest or string literal spelled `instance` is never
		// mistaken for the call.
		if (cursor.type.name !== "Invoke") continue;
		const id = readInstanceArgument(trimmed, cursor.node);
		if (id !== null) ids.add(id);
	} while (cursor.next());

	return ids;
}

/**
 * Given an `Invoke` node, return the unquoted id when it is an
 * `instance('<id>')` call, or `null` otherwise. Reads the node's `FunctionName`
 * and the first `StringLiteral` inside its `ArgumentList` directly off the tree
 * — no text heuristics.
 */
function readInstanceArgument(
	source: string,
	invoke: SyntaxNode,
): string | null {
	const fnName = invoke.firstChild;
	if (fnName === null || fnName.type.name !== "FunctionName") return null;
	if (source.slice(fnName.from, fnName.to) !== "instance") return null;

	// The argument list is the `Invoke`'s second child; find the first
	// StringLiteral inside it. `instance()` with no argument or a non-literal
	// argument (a variable, a nested call) is not a resolvable static instance
	// reference, so it contributes nothing.
	const argList = fnName.nextSibling;
	if (argList === null || argList.type.name !== "ArgumentList") return null;

	for (
		let child = argList.firstChild;
		child !== null;
		child = child.nextSibling
	) {
		if (child.type.name !== "StringLiteral") continue;
		return unquoteXPathStringLiteral(source.slice(child.from, child.to));
	}
	return null;
}

/**
 * Strip the surrounding quotes from an XPath string literal and collapse the
 * doubled-quote escape (`''` inside a single-quoted literal → `'`). The Lezer
 * `StringLiteral` token includes its delimiters; this returns the logical
 * string value the runtime sees.
 */
function unquoteXPathStringLiteral(literal: string): string {
	if (literal.length < 2) return literal;
	const quote = literal[0];
	const inner = literal.slice(1, -1);
	// Single- and double-quoted literals both escape the delimiter by doubling.
	return inner.split(`${quote}${quote}`).join(quote);
}
