// components/builder/case-operations/keyboardMove.ts
//
// What one keyboard reorder of a case change does, and what it says.
//
// The decision itself is the shared `planKeyboardReorder`
// (`components/builder/shared/keyboardReorderPlan.ts`): the three
// outcomes, the at-edge sentence, and the "did not move" framing are the
// same for every reorderable list in the builder. What is this surface's
// own is the verdict and its words: the planner's
// `caseOperationMoveVerdicts` map (`lib/doc/caseOperationReview.ts`),
// which the drag gate reads too, and `moveRefusalReason`, which turns a
// refusal into a sentence naming the changes it is about.

import {
	type KeyboardReorderOutcome,
	planKeyboardReorder,
	type ReorderKey,
} from "@/components/builder/shared/keyboardReorderPlan";
import type {
	CaseOperationMoveVerdict,
	CaseOperationReviewName,
} from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";
import { moveRefusalReason } from "./refusalCopy";

export type { ReorderKey };

export type KeyboardMoveOutcome = KeyboardReorderOutcome;

interface KeyboardMoveArgs {
	/** Operations in execution order. */
	readonly order: readonly Uuid[];
	readonly index: number;
	readonly key: ReorderKey;
	/** The move planner's answer for every destination index. */
	readonly verdicts: ReadonlyMap<number, CaseOperationMoveVerdict>;
	/** How each operation is named in a sentence. */
	readonly nameOf: CaseOperationReviewName;
	/** The creates the moved operation consumes, in execution order:
	 *  what a refusal names when the move would break its OWN references
	 *  rather than someone else's. */
	readonly dependsOn: readonly Uuid[];
}

/**
 * Decide one keyboard reorder of a case change.
 *
 * Every arm returns a sentence, because every arm is something the
 * author needs told: it moved and where to, it was already at the end,
 * or the sequence it asked for cannot be carried and here is why.
 */
export function planKeyboardMove(
	args: KeyboardMoveArgs,
): KeyboardMoveOutcome | undefined {
	const { order, index, key, verdicts, nameOf, dependsOn } = args;
	const uuid = order[index];
	if (uuid === undefined) return undefined;
	return planKeyboardReorder({
		order,
		index,
		key,
		verdicts,
		name: nameOf(uuid) ?? "This change",
		refusalOf: (verdict) =>
			verdict.ok
				? undefined
				: moveRefusalReason(verdict, nameOf, { moved: uuid, dependsOn }),
	});
}
