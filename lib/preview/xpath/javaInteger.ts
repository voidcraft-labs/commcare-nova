/**
 * Java 17's `Integer.parseInt(String)` reads one UTF-16 `char` at a time and
 * resolves it through `Character.digit(char, 10)`. These are the BMP decimal
 * digit blocks that therefore participate in JavaRosa integer parsing.
 */
const JAVA_17_BMP_DECIMAL_DIGIT_STARTS = [
	0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
	0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040,
	0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0,
	0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
	0xff10,
] as const;

/** `Character.digit(char, 10)` for the BMP decimal digits Java 17 accepts. */
export function javaBmpDecimalDigit(character: string): number | undefined {
	if (character.length !== 1) return undefined;
	const code = character.charCodeAt(0);
	for (const start of JAVA_17_BMP_DECIMAL_DIGIT_STARTS) {
		if (code >= start && code < start + 10) return code - start;
	}
	return undefined;
}

/**
 * Normalize the exact lexical language accepted by Java's base-10
 * `Integer.parseInt`, retaining the optional sign and rejecting whitespace,
 * separators, supplementary code points, and a sign without digits.
 */
export function normalizeJavaIntegerLexical(value: string): string | undefined {
	if (value.length === 0) return undefined;
	let index = 0;
	let normalized = "";
	const first = value[0];
	if (first === "+" || first === "-") {
		normalized = first;
		index = 1;
	}
	if (index === value.length) return undefined;
	for (; index < value.length; index += 1) {
		const digit = javaBmpDecimalDigit(value[index] ?? "");
		if (digit === undefined) return undefined;
		normalized += String(digit);
	}
	return normalized;
}
