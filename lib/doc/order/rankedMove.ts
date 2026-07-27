// lib/doc/order/rankedMove.ts
//
// The move primitive for a gesture that names a DISPLAY INDEX — "put this row
// third", "move it up one" — as opposed to `keysForSlot`, which answers the
// different question "give me a key for the slot between these two neighbours".
//
// A single key cannot always answer the first one. Sequence is `(order, uuid)`,
// so display-adjacent siblings may share an order key and be separated only by
// their immutable uuids. For a mover `M` to land between siblings `X` and `Y`
// that share key `K`: a key above `K` sorts after BOTH, a key below `K` sorts
// before BOTH, and `K` itself is decided purely by `M`'s uuid — which the
// author cannot change. The destination is reachable by one key exactly when
// `X.uuid < M.uuid < Y.uuid` happens to hold.
//
// So a plan is a key for the mover PLUS the siblings that had to be re-keyed to
// open a gap for it. The common case re-keys nothing; a re-key happens only
// inside a tied run or the un-keyed suffix, and then only on the shorter side of
// the destination, so a move stays a small, mergeable batch.
//
// `planRankedMove` is TOTAL: every input has a plan and it never throws. Order
// keys are wire-open strings, so a foreign-authored `"0"` or `"a0"` is a
// neighbour Nova has to place a row against, not an error to raise.

import { keyBetween, keysBetween, normalizedKey } from "./keys";

/** A sibling as the ranked move sees it: identity plus its resolved key. */
export interface RankedItem<Id extends string = string> {
	readonly uuid: Id;
	readonly order?: string;
}

/** One sibling whose key the plan changes so the mover's rank is reachable. */
export interface RankedRekey<Id extends string = string> {
	readonly uuid: Id;
	readonly order: string;
}

export interface RankedMovePlan<Id extends string = string> {
	/** The key the moved row takes. */
	readonly order: string;
	/**
	 * Siblings the move re-keys, ascending. EMPTY in the common case — only a
	 * tied run or the un-keyed suffix forces one, and then only the shorter
	 * side of the destination. Relative sibling order is always preserved.
	 */
	readonly rekeys: readonly RankedRekey<Id>[];
}

/**
 * The key the moved row takes to land at `toIndex`, plus the siblings that had
 * to move out of its way.
 *
 * `siblings` is the OTHER rows in DISPLAY order, the mover already removed —
 * the same sequence the caller renders. `toIndex` is the index the row should
 * occupy in that sequence, clamped into range.
 *
 * `compareUuid` must be the tie-break the caller's OWN display sort uses, since
 * that is what decides a row's rank among equal keys: `orderedCaseOperations`
 * ties on `uuid.localeCompare`, `compare.ts::bySortKey` on `<` / `>`. Passing
 * the other one would let this plan believe a reused key lands the row at
 * `toIndex` while the document sorts it elsewhere — exactly the defect a ranked
 * move exists to close, which is why there is no default.
 *
 * Applying `order` to the mover AND every rekey lands the mover at `toIndex`
 * and leaves the siblings in their original relative order.
 */
export function planRankedMove<Id extends string>(
	siblings: readonly RankedItem<Id>[],
	movedUuid: Id,
	toIndex: number,
	compareUuid: (left: Id, right: Id) => number,
): RankedMovePlan<Id> {
	const count = siblings.length;
	const slot = Math.max(0, Math.min(toIndex, count));
	const lower = slot > 0 ? siblings[slot - 1] : undefined;
	const upper = slot < count ? siblings[slot] : undefined;

	// Nothing above the slot holds a key. A keyed row always sorts ahead of an
	// un-keyed one, so the mover only has to clear the keyed siblings below it —
	// and an un-keyed sibling that must stay BELOW it needs a key of its own,
	// which is the only reason this arm re-keys. Landing at the START of the
	// un-keyed suffix therefore costs nothing.
	if (upper === undefined || upper.order === undefined) {
		let unkeyedStart = slot;
		while (unkeyedStart > 0 && siblings[unkeyedStart - 1].order === undefined) {
			unkeyedStart--;
		}
		const below =
			unkeyedStart > 0 ? (siblings[unkeyedStart - 1].order ?? null) : null;
		// One key per sibling being lifted, plus the mover's own — it goes last.
		const keys = keysBetween(below, null, slot - unkeyedStart + 1);
		return {
			order: keys[keys.length - 1],
			rekeys: keys.slice(0, -1).map((order, offset) => ({
				uuid: siblings[unkeyedStart + offset].uuid,
				order,
			})),
		};
	}

	const upperKey = upper.order;
	// Feasibility is judged NUMERICALLY (trailing zero digits carry no value)
	// because that is `keyBetween`'s precondition, and a key minted strictly
	// between two normalized bounds also sorts strictly between the RAW bounds
	// the comparator reads. The converse does not hold: `"a"` and `"a0"` are
	// raw-distinct with no key of any kind between them, so they re-key.
	const upperValue = normalizedKey(upperKey);
	if (lower === undefined || lower.order === undefined) {
		// Nothing below the slot: any key under `upper` lands first. A neighbour
		// whose key is numerically ZERO has nothing under it at all, so that one
		// falls through to the re-key path.
		if (upperValue.length > 0) {
			return { order: keyBetween(null, upperKey), rekeys: [] };
		}
	} else {
		const lowerValue = normalizedKey(lower.order);
		if (lowerValue < upperValue) {
			return { order: keyBetween(lower.order, upperKey), rekeys: [] };
		}
		if (
			lower.order === upperKey &&
			compareUuid(lower.uuid, movedUuid) < 0 &&
			compareUuid(movedUuid, upper.uuid) < 0
		) {
			// The neighbours are separated by uuid alone and the mover's uuid falls
			// in that gap: it joins the tie and lands exactly here, keys untouched.
			return { order: lower.order, rekeys: [] };
		}
	}

	// No key sorts strictly between the neighbours, so the tied run has to open
	// a gap. Re-key the side of the destination holding FEWER siblings, and the
	// upper side on a draw, so the choice is deterministic rather than dependent
	// on which neighbour was inspected first.
	let runStart = slot;
	while (runStart > 0) {
		const key = siblings[runStart - 1].order;
		if (key === undefined || normalizedKey(key) !== upperValue) break;
		runStart--;
	}
	let runEnd = slot;
	while (runEnd < count) {
		const key = siblings[runEnd].order;
		if (key === undefined || normalizedKey(key) !== upperValue) break;
		runEnd++;
	}
	// An un-keyed sibling bounding the run is a null bound: it sorts after every
	// key, so the run may be lifted under it freely.
	const below = runStart > 0 ? (siblings[runStart - 1].order ?? null) : null;
	const above = runEnd < count ? (siblings[runEnd].order ?? null) : null;
	const liftable = above === null || upperValue < normalizedKey(above);
	const sinkable =
		below === null ? upperValue.length > 0 : normalizedKey(below) < upperValue;

	if (liftable && (!sinkable || runEnd - slot <= slot - runStart)) {
		// The mover takes the first of the new keys and the lifted run follows.
		const keys = keysBetween(upperValue, above, runEnd - slot + 1);
		return {
			order: keys[0],
			rekeys: keys.slice(1).map((order, offset) => ({
				uuid: siblings[slot + offset].uuid,
				order,
			})),
		};
	}
	if (sinkable) {
		// The sunk run keeps its order below the mover, which takes the last key.
		const keys = keysBetween(below, upperValue, slot - runStart + 1);
		return {
			order: keys[keys.length - 1],
			rekeys: keys.slice(0, -1).map((order, offset) => ({
				uuid: siblings[runStart + offset].uuid,
				order,
			})),
		};
	}
	// Neither side can be opened, which takes a `siblings` sequence that is not
	// in display order. Totality outranks placement here: append rather than
	// throw, so a caller is never left without a plan.
	return { order: keyBetween(upperValue, null), rekeys: [] };
}
