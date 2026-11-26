/** XPath has two literal delimiters and no delimiter escape. Each part can
 * be enclosed by one delimiter. Wire targets may apply additional escaping. */
export function xpathLiteralParts(text: string, keepEmpty = false): string[] {
	if (!text.includes("'") || !text.includes('"')) return [text];
	const parts: string[] = [];
	for (const [i, part] of text.split("'").entries()) {
		if (i > 0) parts.push("'");
		if (keepEmpty || part.length > 0) parts.push(part);
	}
	return parts;
}

export function quoteXPathLiteral(text: string, keepEmpty = false): string {
	const tokens = xpathLiteralParts(text, keepEmpty).map((piece) =>
		piece.includes("'") ? `"${piece}"` : `'${piece}'`,
	);
	return tokens.length === 1 ? tokens[0] : `concat(${tokens.join(", ")})`;
}
