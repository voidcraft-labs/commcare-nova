// A fixed date pair is already in the answer spelling Core and both worker
// widgets accept. Its dates therefore survive the pinned Android formatter's
// zone-dependent conversion of a human-readable starting calculation.

import { type Expression, literal, term } from "@/lib/domain/expression";
import { searchStartingDatesSchema } from "@/lib/domain/modules";

export function fixedSearchRangeExpression(
	from: string,
	to: string,
): Expression {
	return term(literal(`__range__${from}__${to}`));
}

export function fixedSearchRangeDates(
	value: Expression | undefined,
): { from: string; to: string } | undefined {
	if (
		value?.kind !== "term" ||
		value.term.kind !== "literal" ||
		typeof value.term.value !== "string"
	)
		return undefined;
	// Core converts human-readable bounds in the worker's zone. A calculation
	// that returns them must still do so after its author reopens the editor.
	const match = /^__range__(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})$/.exec(
		value.term.value,
	);
	if (!match) return undefined;
	const pair = searchStartingDatesSchema.safeParse({
		from: match[1],
		to: match[2],
	});
	return pair.success ? pair.data : undefined;
}
