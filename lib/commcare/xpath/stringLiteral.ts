// lib/commcare/xpath/stringLiteral.ts
//
// Building an XPath 1.0 string literal from an arbitrary value.
//
// One home, because every emitter that interpolates authored or derived
// text into an expression body needs this encoding, and two copies would
// eventually disagree about the value that contains both quote
// characters.

/**
 * Render `value` as a valid XPath 1.0 string literal.
 *
 * XPath 1.0 has no escape sequence inside string literals: a `'...'` literal
 * cannot contain `'`, a `"..."` literal cannot contain `"`. The standard
 * encoding picks the delimiter the value doesn't contain, and falls back to
 * `concat()` (alternating delimiters across pieces) when the value contains
 * BOTH quote characters. The result is always parse-safe under JavaRosa's
 * XPath evaluator.
 *
 * The XML serializer escapes the returned string into the attribute value
 * separately — its `'` / `"` escaping is XML-spec, not XPath-spec, so a
 * downstream `&apos;` decodes back to `'` before JavaRosa parses the
 * expression. Both layers compose correctly.
 */
export function xpathStringLiteral(value: string): string {
	const hasSingle = value.includes("'");
	const hasDouble = value.includes('"');
	if (!hasSingle) return `'${value}'`;
	if (!hasDouble) return `"${value}"`;
	// Both quote characters present — split on `'` and reassemble via
	// `concat()`, alternating single-quoted pieces with the literal `"'"`
	// rendered as the double-quoted literal that joins them. Each piece is
	// safe in its own delimiter because the split removes the only
	// disqualifying character.
	const pieces = value.split("'");
	const parts: string[] = [];
	for (let i = 0; i < pieces.length; i++) {
		if (i > 0) parts.push(`"'"`);
		if (pieces[i].length > 0) parts.push(`'${pieces[i]}'`);
	}
	return `concat(${parts.join(", ")})`;
}
