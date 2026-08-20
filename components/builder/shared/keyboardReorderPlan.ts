// components/builder/shared/keyboardReorderPlan.ts
//
// What one keyboard reorder does, and what it says, for any ordered list
// whose positions the document can refuse.
//
// A pointer user learns a destination is unavailable from the drop zone
// itself: the row refuses to open a gap. A keyboard user gets nothing from
// a key that silently does nothing, so every refused move ANNOUNCES why.
// That parity is the point of this file, and it is why the decision is
// generic: case changes and after-submit links have different reasons a
// position can be refused, but the same three outcomes and the same
// sentences around them.
//
// The verdict itself is the caller's move planner's, read out of the same
// per-destination map its drag gate consults, so keyboard and drag cannot
// disagree about what is legal: they are two readings of one map.
//
// Only the outcomes that DID NOT move carry their own words. A committed
// move is described by the canvas from the document after the commit,
// because the rank the author lands at is a fact about the committed
// sequence, not about the index this plan requested: a peer's concurrent
// edit is exactly the case where the two differ.

export type ReorderKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

export type KeyboardReorderOutcome =
	/** Commit the move. The caller says where it landed, from the committed
	 *  document: see the note above. */
	| { readonly kind: "move"; readonly toIndex: number }
	/** Already at the end it was asked to travel toward. */
	| { readonly kind: "at-edge"; readonly announcement: string }
	/** The planner refuses this destination. Nothing commits, and the screen
	 *  is otherwise unchanged, so the sentence is the whole feedback. */
	| { readonly kind: "refused"; readonly announcement: string };

export interface KeyboardReorderArgs<K, V> {
	/** The items, in the order they currently hold. */
	readonly order: readonly K[];
	readonly index: number;
	readonly key: ReorderKey;
	/** The move planner's answer for every destination index. */
	readonly verdicts: ReadonlyMap<number, V>;
	/** How the moved item is named in a sentence ("create_referral"). */
	readonly name: string;
	/** Why a destination's verdict refuses it, or `undefined` when it is
	 *  available. The caller owns the wording: it knows what its verdicts
	 *  are about. */
	readonly refusalOf: (verdict: V) => string | undefined;
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
export function reorderDirection(key: ReorderKey): "earlier" | "later" {
	return key === "ArrowUp" || key === "Home" ? "earlier" : "later";
}

/**
 * Decide one keyboard reorder.
 *
 * Every arm returns a sentence, because every arm is something the author
 * needs told: it moved and where to, it was already at the end, or the
 * sequence it asked for cannot be carried and here is why. `undefined`
 * only for an index that names nothing.
 */
export function planKeyboardReorder<K, V>(
	args: KeyboardReorderArgs<K, V>,
): KeyboardReorderOutcome | undefined {
	const { order, index, key, verdicts, name, refusalOf } = args;
	if (order[index] === undefined) return undefined;
	const toIndex = destinationIndex(index, key, order.length);

	if (toIndex < 0 || toIndex >= order.length || toIndex === index) {
		return {
			kind: "at-edge",
			announcement: `${name} is already ${reorderDirection(key) === "earlier" ? "first" : "last"}.`,
		};
	}

	const verdict = verdicts.get(toIndex);
	const refusal = verdict === undefined ? undefined : refusalOf(verdict);
	if (refusal !== undefined) {
		return {
			kind: "refused",
			// The name leads so a screen reader announces WHICH item did not
			// move before the reason: on a long list the author may have
			// arrowed several rows since they last heard a name.
			announcement: `${name} did not move ${reorderDirection(key)}. ${refusal}`,
		};
	}

	return { kind: "move", toIndex };
}
