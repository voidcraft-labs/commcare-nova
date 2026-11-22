function jsonCharsOf(codePoint: number): number {
	if (codePoint === 0x22 || codePoint === 0x5c) return 2;
	if (codePoint < 0x20)
		return codePoint === 0x08 ||
			codePoint === 0x09 ||
			codePoint === 0x0a ||
			codePoint === 0x0c ||
			codePoint === 0x0d
			? 2
			: 6;
	/* A lone surrogate is written as an escape. */
	if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
	return codePoint > 0xffff ? 2 : 1;
}

/**
 * `line` cut into parts of at most `limit` characters of JSON
 * each, never inside a code point; the line itself where it fits.
 */
export function lineParts(line: string, limit: number): readonly string[] {
	if (JSON.stringify(line).length <= limit) return [line];
	const budget = limit - 2;
	const parts: string[] = [];
	let start = 0;
	let size = 0;
	let at = 0;
	for (const char of line) {
		const cost = jsonCharsOf(char.codePointAt(0) ?? 0);
		if (size + cost > budget) {
			parts.push(line.slice(start, at));
			start = at;
			size = 0;
		}
		size += cost;
		at += char.length;
	}
	parts.push(line.slice(start));
	return parts;
}
