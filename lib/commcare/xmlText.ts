/** XML 1.0 fifth edition, production [2] Char. A Unicode-mode match treats a
 * surrogate pair as one code point and rejects either unpaired half. This is
 * a character repertoire check on authored text, never an XML/XPath parser. */
const UNSUPPORTED_CHARACTER =
	/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;

export function xmlTextIssue(value: string): string | undefined {
	const match = UNSUPPORTED_CHARACTER.exec(value);
	if (match === null) return undefined;
	// Every excluded code point is in the BMP, including unpaired surrogates.
	const code = match[0].charCodeAt(0);
	return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}
