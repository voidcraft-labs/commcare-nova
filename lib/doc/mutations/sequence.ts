/**
 * The one sequence primitive every collection shares.
 *
 * Sequence is array position, so every add and every move is the same
 * operation: put this uuid after that one. There is no key to mint, no interval
 * to widen, and no tie to break — which is why this is the whole of it.
 *
 * `spliceAfter` is TOTAL and IDEMPOTENT, and both properties are load-bearing
 * because reducers replay:
 *
 *   - It removes the uuid before re-inserting, so applying the same move twice
 *     lands the same sequence rather than duplicating the entry.
 *   - An `after` naming something absent appends rather than throwing. A peer
 *     may have removed the anchor between the author's gesture and the replay,
 *     and a reducer that threw there would make a historical fold unreplayable.
 *
 * `null` means first, `undefined` means append. They are distinct on purpose: a
 * command that says "put this at the top" and one that says "put this wherever
 * it goes" are different intents, and collapsing them would silently move new
 * entities to the top of every collection.
 */
export function spliceAfter<Id extends string>(
	sequence: readonly Id[] | undefined,
	uuid: Id,
	after: Id | null | undefined,
): Id[] {
	const without = (sequence ?? []).filter((entry) => entry !== uuid);
	if (after === null) return [uuid, ...without];
	if (after === undefined) return [...without, uuid];
	const at = without.indexOf(after);
	if (at < 0) return [...without, uuid];
	return [...without.slice(0, at + 1), uuid, ...without.slice(at + 1)];
}

/**
 * The uuid a given entry currently follows — `null` when it is first, and
 * `undefined` when the sequence does not hold it at all.
 *
 * This is what makes a move's inverse trivial: undoing "put X after Y" is
 * "put X after whatever it followed before", read off the document the move was
 * about to be applied to.
 */
export function predecessorOf<Id extends string>(
	sequence: readonly Id[] | undefined,
	uuid: Id,
): Id | null | undefined {
	const at = (sequence ?? []).indexOf(uuid);
	if (at < 0) return undefined;
	if (at === 0) return null;
	return (sequence as readonly Id[])[at - 1];
}

/** Drop an entry from a sequence, preserving the order of everything else. */
export function withoutEntry<Id extends string>(
	sequence: readonly Id[] | undefined,
	uuid: Id,
): Id[] {
	return (sequence ?? []).filter((entry) => entry !== uuid);
}
