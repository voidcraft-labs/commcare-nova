// components/builder/case-operations/keyboardMove.ts
//
// What one keyboard reorder does, and what it says.
//
// A pointer user learns a destination is unavailable from the drop zone
// itself: the row refuses to open a gap. A keyboard user gets nothing
// from a key that silently does nothing, so every refused ArrowUp
// ANNOUNCES why, naming the operations the refusal is about. That
// parity is the point of this file.
//
// The verdict itself is the move planner's, read out of the same
// `caseOperationMoveVerdicts` map the drag gate consults
// (`lib/doc/caseOperationReview.ts`). Keyboard and drag therefore cannot
// disagree about what is legal: they are two readings of one map.
//
// Only the outcomes that DID NOT move carry their own words. A committed
// move is described by the canvas from the document after the commit,
// because the rank the author lands at is a fact about the committed
// sequence, not about the index this plan requested: a peer's concurrent
// edit is exactly the case where the two differ.

import type {
	CaseOperationMoveVerdict,
	CaseOperationReviewName,
} from "@/lib/doc/caseOperationReview";
import type { Uuid } from "@/lib/doc/types";
import { moveRefusalReason } from "./refusalCopy";

export type ReorderKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

export type KeyboardMoveOutcome =
	/** Commit the move. The caller says where it landed, from the committed
	 *  document: see the note above. */
	| { readonly kind: "move"; readonly toIndex: number }
	/** Already at the end it was asked to travel toward. */
	| { readonly kind: "at-edge"; readonly announcement: string }
	/** The planner refuses this destination. Nothing commits, and the screen
	 *  is otherwise unchanged, so the sentence is the whole feedback. */
	| { readonly kind: "refused"; readonly announcement: string };

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

function destinationIndex(
	index: number,
	key: ReorderKey,
	length: number,
): number {
	switch (key) {
		case "Home":
			return 0;
		case "End":
			return length - 1;
		case "ArrowUp":
			return index - 1;
		case "ArrowDown":
			return index + 1;
	}
}

/** "earlier" / "later" as the author experiences the key. */
function direction(key: ReorderKey): "earlier" | "later" {
	return key === "ArrowUp" || key === "Home" ? "earlier" : "later";
}

/**
 * Decide one keyboard reorder.
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
	const name = nameOf(uuid) ?? "This change";
	const toIndex = destinationIndex(index, key, order.length);

	if (toIndex < 0 || toIndex >= order.length || toIndex === index) {
		return {
			kind: "at-edge",
			announcement: `${name} is already ${direction(key) === "earlier" ? "first" : "last"}.`,
		};
	}

	const verdict = verdicts.get(toIndex);
	if (verdict !== undefined && !verdict.ok) {
		const message = moveRefusalReason(verdict, nameOf, {
			moved: uuid,
			dependsOn,
		});
		return {
			kind: "refused",
			// The name leads so a screen reader announces WHICH change did not
			// move before the reason: on a twenty-change form the author may
			// have arrowed several rows since they last heard a name.
			announcement: `${name} did not move ${direction(key)}. ${message}`,
		};
	}

	return { kind: "move", toIndex };
}
