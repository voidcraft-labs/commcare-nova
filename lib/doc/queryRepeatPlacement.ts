/**
 * The move planner for held query repeats: a query repeat a publish holds at
 * model iteration (its rows set when the form opens) whose edit leaves it in
 * a shape model iteration cannot run moves to the count placement (its rows
 * follow the cases found), recorded as held at once.
 *
 * No answer moves: the wrapper and its rows keep their paths. Each row's
 * record id moves to a new place in the submission, so from the next
 * publish CommCare HQ's exports read it from a new column, which the move
 * states. A held count expresses every query repeat, so it never moves, and
 * an unheld repeat takes its effective placement freely, so it is never
 * stated.
 */

import type { IdentityMove } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { PlacementHoldEntry } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formOfField } from "@/lib/domain/fieldForm";
import { queryRepeatPlacementNeeds } from "@/lib/domain/queryRepeatPlacement";

type QueryRepeatHoldEntry = Extract<
	PlacementHoldEntry,
	{ target: "query-repeat" }
>;

export interface QueryRepeatPlacementMoves {
	/** Each moved repeat's hold, now `count`, in document order. */
	readonly holds: readonly QueryRepeatHoldEntry[];
	/** The move each of those holds makes, in the same order. */
	readonly moves: readonly IdentityMove[];
}

/**
 * Over the candidate an edit produces: every query repeat held at model
 * iteration that the candidate leaves with a need model iteration cannot
 * run, its hold to `count`, with the move naming its first need.
 */
export function planQueryRepeatPlacementMoves(
	candidate: BlueprintDoc,
): QueryRepeatPlacementMoves {
	const holds: QueryRepeatHoldEntry[] = [];
	const moves: IdentityMove[] = [];
	for (const hold of readPlacementHolds(candidate).values()) {
		if (hold.target !== "query-repeat" || hold.placement !== "model-iteration")
			continue;
		const formUuid = formOfField(candidate, hold.fieldUuid);
		const structure =
			formUuid === undefined ? undefined : formStructure(candidate, formUuid);
		if (formUuid === undefined || structure === undefined) continue;
		const [need] = queryRepeatPlacementNeeds(structure, hold.fieldUuid);
		if (need === undefined) continue;
		holds.push({
			target: "query-repeat",
			fieldUuid: hold.fieldUuid,
			placement: "count",
		});
		moves.push({
			subject: { kind: "query-repeat", formUuid, fieldUuid: hold.fieldUuid },
			from: "rows-set-when-opened",
			to: "rows-follow-query",
			reason: { source: "query-repeat", reason: need },
		});
	}
	return { holds, moves };
}
