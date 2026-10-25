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

/**
 * The fixed pattern that spells an instant the way Core reads one back with
 * its clock: the local wall time and that instant's offset
 * (`XPathFormatDateFunc.java::dateStr`, `DateUtils.java::format`).
 */
export const INSTANT_TEXT_PATTERN = "%Y-%m-%dT%H:%M:%S.%3%Z";

/** A `format-date` whose pattern is fixed to `INSTANT_TEXT_PATTERN`. */
export function isInstantText(expression: Expression): boolean {
	return (
		expression.kind === "format-date" &&
		fixedDatePattern(expression.pattern) === INSTANT_TEXT_PATTERN
	);
}

/**
 * The clock-keeping date: `date(format-date(X, '%Y-%m-%dT%H:%M:%S.%3%Z'))`.
 * Core's `date()` of text parses it with its clock and does not round
 * (`FunctionUtils.java::toDate`), so the result is a `Date` that keeps its
 * time of day, which an `xsd:dateTime` bind holds as `DateTimeData`
 * (`Recalculate.java::wrapData`). Read from the tree, never from text.
 */
export function isClockKeepingDate(expression: Expression): boolean {
	return expression.kind === "date-coerce" && isInstantText(expression.value);
}

/**
 * The clock-keeping join of a date answer and a time answer, blank when
 * either is blank:
 * `date(format-date(if(D = '' or T = '', '', concat(D, 'T', T)), '%Y-%m-%dT%H:%M:%S.%3%Z'))`.
 * The date-and-time split's joined value, and the one shape typing rule R2
 * and bind rule R3 recognize as a date and time held with its clock.
 */
export function clockKeepingJoin(
	date: Expression,
	time: Expression,
): Expression {
	// Every node is its own object, so the tree shares no reference a later
	// draft could edit in two places at once.
	const blank = (): Expression => ({
		kind: "term",
		term: { kind: "literal", value: "" },
	});
	return {
		kind: "date-coerce",
		value: {
			kind: "format-date",
			pattern: INSTANT_TEXT_PATTERN,
			date: {
				kind: "if",
				cond: {
					kind: "or",
					clauses: [
						{ kind: "eq", left: structuredClone(date), right: blank() },
						{ kind: "eq", left: structuredClone(time), right: blank() },
					],
				},
				// biome-ignore lint/suspicious/noThenProperty: Persisted AST branch data is never callable.
				then: blank(),
				else: {
					kind: "concat",
					parts: [
						structuredClone(date),
						{ kind: "term", term: { kind: "literal", value: "T" } },
						structuredClone(time),
					],
				},
			},
		},
	};
}
