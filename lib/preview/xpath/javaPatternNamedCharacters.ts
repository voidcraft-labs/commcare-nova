const NAMED_CHARACTER_ESCAPE = String.raw`\N{`;

/**
 * OpenJDK resolves \N{name} through Character.codePointOf. TeaVM does not
 * provide that table, so load the pinned JDK 17 names only for patterns that
 * actually use the construct and lower recognized names to Java's equivalent
 * \x{codePoint} syntax before entering Pattern.
 */
export async function prepareOpenJdk17Pattern(
	pattern: string,
): Promise<string> {
	if (!pattern.includes(NAMED_CHARACTER_ESCAPE)) return pattern;

	const { openJdk17CodePointOf } = await import(
		"./vendor/javaPatternNames.generated"
	);
	let result = "";
	let cursor = 0;
	let quoted = false;
	while (cursor < pattern.length) {
		const character = pattern[cursor];
		if (character !== "\\") {
			result += character;
			cursor += 1;
			continue;
		}

		const escaped = pattern[cursor + 1];
		if (quoted) {
			result += character;
			if (escaped === "E") {
				result += escaped;
				cursor += 2;
				quoted = false;
			} else {
				cursor += 1;
			}
			continue;
		}

		if (escaped === "Q") {
			result += "\\Q";
			cursor += 2;
			quoted = true;
			continue;
		}
		if (escaped !== "N" || pattern[cursor + 2] !== "{") {
			result += character;
			if (escaped !== undefined) {
				result += escaped;
				cursor += 2;
			} else {
				cursor += 1;
			}
			continue;
		}

		const close = pattern.indexOf("}", cursor + 3);
		if (close < 0) {
			result += pattern.slice(cursor);
			break;
		}
		const namedEscape = pattern.slice(cursor, close + 1);
		const name = pattern.slice(cursor + 3, close);
		const codePoint = openJdk17CodePointOf(name);
		result +=
			codePoint === undefined
				? namedEscape
				: `\\x{${codePoint.toString(16).toUpperCase()}}`;
		cursor = close + 1;
	}
	return result;
}
