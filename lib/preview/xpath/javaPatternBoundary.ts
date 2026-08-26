/**
 * Integration boundary for the Java Pattern semantics CommCare Core uses.
 *
 * Native JavaScript RegExp is deliberately not a fallback: Unicode classes,
 * character-class intersections, flags, quoting, lookbehind, and replacement
 * parsing differ observably. An adapter must therefore provide the complete
 * Pattern/Matcher operations below from an audited Java runtime before Preview
 * advertises these functions. Nova's implementation compiles the pinned
 * OpenJDK 17 sources to a static JavaScript module; it does not use WebAssembly.
 */
export interface JavaPatternEngine {
	find(pattern: string, input: string): boolean;
	replaceAllLiteral(
		pattern: string,
		input: string,
		literalReplacement: string,
	): string;
}

export interface JavaPatternFunctions {
	regex(input: string, pattern: string): boolean;
	replace(input: string, pattern: string, replacement: string): string;
}

export function createJavaPatternFunctions(
	engine: JavaPatternEngine,
): JavaPatternFunctions {
	return {
		// Core uses Matcher.find(): an unanchored pattern may match a substring.
		regex: (input, pattern) => engine.find(pattern, input),
		// Core applies Matcher.quoteReplacement before replaceAll. The engine
		// boundary owns that behavior so `$` and `\\` are never group syntax.
		replace: (input, pattern, replacement) =>
			engine.replaceAllLiteral(pattern, input, replacement),
	};
}
