// lib/agent/extractNormalization.ts
//
// Pure repair for a document extract the summarizer emitted DOUBLE-escaped. Kept
// in its own dep-free leaf (no mammoth/xlsx, no I/O) so every consumer — the
// extraction core, the single-flight store, the preview route — imports the same
// repair cheaply, and so the store/route tests run the REAL function instead of a
// stub (they mock `documentExtraction` only to avoid the office parsers + the
// model call).

/**
 * Decode ONE JSON-string escape level from a string — the inverse of writing the
 * string as a JSON string body. Total (never throws): a recognized escape decodes,
 * an unrecognized one keeps its character (the backslash is dropped), so any input
 * maps to some output. Mirrors the standard JSON escapes (`\" \\ \/ \b \f \n \r \t`
 * and `\uXXXX`). Used only by `normalizeExtractText`; see there for when.
 */
function decodeJsonStringEscapes(s: string): string {
	return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, esc: string) => {
		switch (esc[0]) {
			case '"':
				return '"';
			case "\\":
				return "\\";
			case "/":
				return "/";
			case "b":
				return "\b";
			case "f":
				return "\f";
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "u":
				// The `u…` alternative only matches with four hex digits, so a captured
				// `u` of any other length is a malformed `\u` — keep the literal `u`.
				return esc.length === 5
					? String.fromCharCode(Number.parseInt(esc.slice(1), 16))
					: esc;
			default:
				return esc;
		}
	});
}

/**
 * Repair an extract the summarizer emitted DOUBLE-escaped. A model emitting a
 * LARGE markdown document as a JSON string value under structured generation
 * can escape its whole output one level too deep: every newline comes back as
 * the two literal characters `\` `n`, every quote as `\` `"`, and so on,
 * collapsing the entire extract to a single physical line of escape sequences.
 * (Verified by isolation: the SAME large input run as plain text — or as a small
 * structured output — is clean; it's the size of the JSON-string-embedded output
 * that degrades the model's escaping. The instruction prompt can't reliably
 * suppress it, so we repair it after the fact.)
 *
 * The corruption signature is unambiguous: a real multi-section extract ALWAYS has
 * real line breaks, so an extract with NO real newline but a literal `\n` in it is
 * the double-escaped form and nothing else. Gate on exactly that and decode one
 * escape level (`JSON.parse('"' + body + '"')` is the proven inverse on the real
 * corrupted output — here via a total decoder so a malformed escape can't throw on
 * a read path). Every normal extract is returned byte-identical.
 *
 * Applied both when an extract is produced (fresh extracts store clean) and when
 * one is read back from storage (an extract written before this repair existed is
 * fixed on the way out, with no re-extraction). Idempotent — a clean extract has
 * real newlines, so the gate returns it untouched.
 */
export function normalizeExtractText(text: string): string {
	if (text.includes("\n")) return text; // real line breaks → not over-escaped
	if (!text.includes("\\n")) return text; // no escaped newline → nothing to fix
	return decodeJsonStringEscapes(text);
}
