import { resolveCommCareDatePattern } from "../dateFormats";
import type { Expression } from "./types";

/** Bare preset names retain record meaning; a literal expression preserves its exact bytes. */
export function fixedDatePattern(
	pattern: string | Expression,
): string | undefined {
	if (typeof pattern === "string") return resolveCommCareDatePattern(pattern);
	return pattern.kind === "term" &&
		pattern.term.kind === "literal" &&
		typeof pattern.term.value === "string"
		? pattern.term.value
		: undefined;
}

/** The fixed pattern that spells a date the way Core reads one back. */
export const ISO_DATE_PATTERN = "%Y-%m-%d";

/**
 * A `format-date` whose pattern is fixed to `%Y-%m-%d` (or the `iso` preset,
 * which prints as it): its text is `YYYY-MM-DD` or, for a value that is no
 * date, `''` (`XPathFormatDateFunc.java::dateStr`). Read from the tree, never
 * from expression text.
 */
export function isIsoDateText(expression: Expression): boolean {
	return (
		expression.kind === "format-date" &&
		fixedDatePattern(expression.pattern) === ISO_DATE_PATTERN
	);
}
