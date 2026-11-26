import type { SearchInputDef } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";

export type RangeWithDefault = Extract<
	SearchInputDef,
	{ type: "date-range" }
> & { default: Expression };
export function isRangeWithDefault(
	input: SearchInputDef,
): input is RangeWithDefault {
	return (
		input.kind !== "hidden" &&
		input.type === "date-range" &&
		"default" in input &&
		input.default !== undefined
	);
}

export function literalRangeDefault(
	expression: Expression,
): string | undefined {
	return expression.kind === "term" &&
		expression.term.kind === "literal" &&
		typeof expression.term.value === "string"
		? expression.term.value
		: undefined;
}

/** One saved field as the authorized worker's query manager opened it. */
export interface OpenedSearchRange {
	readonly field: RangeWithDefault;
	readonly answers: Readonly<Record<string, string>>;
}

export const RANGE_ANSWER_SUFFIXES = [":starting", ":from", ":to"] as const;

/** A two-digit Web Apps year is relative to the opening year. */
export function needsRangeOpening(field: RangeWithDefault): boolean {
	const literal = literalRangeDefault(field.default);
	return (
		literal === undefined ||
		/(?:^|__| to |#,#)\d{1,2}\D\d{1,2}\D\d{2}(?:$|__| to |#,#)/.test(literal)
	);
}
