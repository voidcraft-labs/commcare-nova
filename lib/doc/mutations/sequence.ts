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

/** One entity's landing: where it goes, and what it follows when it gets there. */
export interface SequenceMove<Id extends string> {
	readonly uuid: Id;
	readonly after: Id | null;
}

/**
 * The moves that turn one sequence into another.
 *
 * Used where a sequence has to be RECOVERED from two states rather than read
 * from the gesture that produced it — the authoritative repair writer, which is
 * handed a target document and has to derive the batch that reaches it. The
 * builder does not use this: it knows what the author did and says so directly,
 * which is the entire point of the change this lives inside.
 *
 * The result is correct, not minimal. It simulates forward, emitting a move
 * only when the next expected entity is not already in place, so a sequence
 * that only had one entity moved yields one move rather than a rewrite of every
 * position after it. Entities absent from `before` are treated as already
 * present at their landing, because their own add carries that placement.
 */
export function sequenceMovesTo<Id extends string>(
	before: readonly Id[],
	after: readonly Id[],
): SequenceMove<Id>[] {
	const target = new Set(after);
	// Only entities that survive into `after` can be moved; a removal is its own
	// mutation and must not be mistaken for a reorder.
	const working = before.filter((uuid) => target.has(uuid));
	const known = new Set(working);
	const moves: SequenceMove<Id>[] = [];

	after.forEach((uuid, index) => {
		if (working[index] === uuid) return;
		const previous = index === 0 ? null : (after[index - 1] as Id);
		// A newcomer's placement rides its add, so it needs no move — but it does
		// have to enter the simulation, or every later comparison is off by one.
		if (known.has(uuid)) moves.push({ uuid, after: previous });
		else known.add(uuid);
		const from = working.indexOf(uuid);
		if (from !== -1) working.splice(from, 1);
		working.splice(index, 0, uuid);
	});

	return moves;
}
