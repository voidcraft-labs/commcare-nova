/** Typed navigation display-condition emission for suite.xml and HQ JSON. */

import { emitCasePropertyWirePath } from "@/lib/commcare/casePropertyWire";
import { emitCaseListFilter } from "@/lib/commcare/predicate";
import type { Predicate } from "@/lib/domain/predicate";
import { effectiveDisplayConditionForEmission } from "@/lib/domain/predicate";

const SELECTED_CASE =
	"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]";

/** Module relevancy runs before case selection, so ordinary on-device terms
 * emit directly; validation has already excluded every case-row term. */
export function emitModuleDisplayCondition(
	condition: Predicate | undefined,
	currentCaseType?: string,
): string | undefined {
	const effective = effectiveDisplayConditionForEmission(condition);
	if (effective === undefined) return undefined;
	return emitCaseListFilter(effective, "casedb", {
		...(currentCaseType !== undefined && { currentCaseType }),
	});
}

/**
 * A form command in a case-first menu evaluates after `case_id` is selected,
 * but its context node is not the case row. Anchor every admitted direct-self
 * property structurally through the selected session datum. No emitted-string
 * rewriting is used: the leaf override is threaded through the typed emitter.
 */
export function emitFormDisplayConditionForSuite(
	condition: Predicate | undefined,
	currentCaseType?: string,
): string | undefined {
	const effective = effectiveDisplayConditionForEmission(condition);
	if (effective === undefined) return undefined;
	return emitCaseListFilter(
		effective,
		"casedb",
		{ ...(currentCaseType !== undefined && { currentCaseType }) },
		undefined,
		{
			emitSelfProperty: (property) =>
				`${SELECTED_CASE}/${emitCasePropertyWirePath(property.property)}`,
		},
	);
}

/**
 * HQ owns `#case` interpolation while regenerating suite.xml. Preserve that
 * contract in `form_filter`, including `@` on reserved case attributes.
 */
export function emitFormDisplayConditionForHq(
	condition: Predicate | undefined,
	currentCaseType?: string,
): string | undefined {
	const effective = effectiveDisplayConditionForEmission(condition);
	if (effective === undefined) return undefined;
	return emitCaseListFilter(
		effective,
		"casedb",
		{ ...(currentCaseType !== undefined && { currentCaseType }) },
		undefined,
		{
			emitSelfProperty: (property) =>
				`#case/${emitCasePropertyWirePath(property.property)}`,
		},
	);
}
