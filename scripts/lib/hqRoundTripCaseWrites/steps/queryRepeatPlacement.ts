/**
 * Step 11, `query-repeat-placement` (part 09 §7.9; part 04 §7.1, class Q1).
 *
 * `main` wrote every query repeat in model iteration, whose rows are the
 * records the query found when the form opened. Step 5 derives each query
 * repeat's placement (`lib/domain/queryRepeatPlacement.ts::
 * effectiveQueryRepeatPlacement`): model iteration only where it gives the
 * rows the query gives, and the count placement, whose rows follow the
 * query as the form is filled in, everywhere else. Nothing is written here:
 * the placement is derived, and the holds a published deployment gives are
 * step `placements`' (section 8). Every query repeat the rule places in the
 * count placement gets `repeat-rows-follow-query`, in any app, published or
 * not.
 */

import { descendantFieldUuids, iterForms } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { repeatRowsFollowQuery } from "../notice";
import type { StepResult } from "./apply";

/** One query repeat whose rows now follow its query. */
export interface CountPlacedQueryRepeat {
	readonly formUuid: Uuid;
	readonly repeatUuid: Uuid;
}

/** Every query repeat whose effective placement is the count placement, in
 *  form order and data-tree order within a form. */
export function countPlacedQueryRepeats(
	doc: BlueprintDoc,
): readonly CountPlacedQueryRepeat[] {
	const repeats: CountPlacedQueryRepeat[] = [];
	for (const { formUuid } of iterForms(doc)) {
		const form = formStructure(doc, formUuid);
		if (form === undefined) continue;
		for (const uuid of descendantFieldUuids(doc, formUuid)) {
			const field = doc.fields[uuid];
			if (field?.kind !== "repeat" || field.repeat_mode !== "query_bound")
				continue;
			if (effectiveQueryRepeatPlacement(form, uuid) === "count")
				repeats.push({ formUuid, repeatUuid: uuid });
		}
	}
	return repeats;
}

/** Step `query-repeat-placement`: notice lines only; the document is
 *  returned as it came. */
export function queryRepeatPlacementStep(doc: BlueprintDoc): StepResult {
	const notice = countPlacedQueryRepeats(doc).map(({ formUuid, repeatUuid }) =>
		repeatRowsFollowQuery(
			{ uuid: repeatUuid, name: doc.fields[repeatUuid]?.id ?? "" },
			doc.forms[formUuid]?.name ?? "",
		),
	);
	return { doc, changes: [], notice, blockers: [] };
}
