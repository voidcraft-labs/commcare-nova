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
