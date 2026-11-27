import type { Column, Module } from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import { w } from "../../xpath/wire/builders";
import { resultsInstance } from "../../xpath/wire/instances";
import { inlineSearchInstance } from "../case-search/types";

type CalculatedColumn = Extract<Column, { kind: "calculated" }>;

export const DEFAULT_INLINE_RESULT_INSTANCE = inlineSearchInstance(undefined);

/** The qualified native expression selects exactly the primary result whose
 * ID equals the rendered case. The rest of Nova reads that value as an
 * ordinary typed property of the selected result row. */
export function inlineResultPropertyWire(property: string) {
	return w.instance(resultsInstance(DEFAULT_INLINE_RESULT_INSTANCE), [
		w.step("results"),
		w.step("case", [
			w.not(
				w.eq(
					w.context([w.step("commcare_is_related_case")]),
					w.call("true", []),
				),
			),
			w.eq(w.context([w.attr("case_id")]), w.current([w.attr("case_id")])),
		]),
		w.step(property),
	]);
}

export function ownInlineResultProperty(
	column: CalculatedColumn,
	caseType: Module["caseType"],
): string | undefined {
	const expression = column.expression;
	if (
		column.inlineResultProperty &&
		caseType !== undefined &&
		expression.kind === "term" &&
		expression.term.kind === "prop" &&
		expression.term.caseType === caseType &&
		!expression.term.readReached &&
		(expression.term.via === undefined ||
			expression.term.via.kind === "self") &&
		authoredCasePropertyNameSchema.safeParse(expression.term.property).success
	)
		return expression.term.property;
}
