// lib/doc/order/compare.ts
//
// The one comparator every order-consumption site sorts through. Sequence
// is DERIVED — `sort-by-(order, uuid)` — because the storage arrays
// (`moduleOrder`, `formOrder[m]`, `fieldOrder[p]`, and the
// `columns`/`searchInputs`/`options` arrays) are membership sets whose
// internal position is no longer authoritative.
//
// `bySortKey` is TOTAL: a backfilled doc gives every entity an `order`, but
// the comparator still defines an answer for a legacy entity missing one —
// an entity with `order` sorts ahead of one without, and two entities both
// missing `order` compare equal so a STABLE sort leaves them in array
// position (the array-position fallback). Equal `order` keys tie-break on
// `uuid` so distinct entities never compare equal on a key collision.

interface Sortable {
	readonly order?: string;
	readonly uuid?: string;
}

function compareUuid(a: string | undefined, b: string | undefined): number {
	const x = a ?? "";
	const y = b ?? "";
	if (x < y) return -1;
	if (x > y) return 1;
	return 0;
}

/**
 * Order two entities by their fractional `order` key, tie-breaking on
 * `uuid`. An absent `order` sorts after a present one; both absent compare
 * equal (0), so a stable sort preserves their relative array position.
 */
export function bySortKey(a: Sortable, b: Sortable): number {
	if (a.order !== undefined && b.order !== undefined) {
		if (a.order < b.order) return -1;
		if (a.order > b.order) return 1;
		return compareUuid(a.uuid, b.uuid);
	}
	if (a.order !== undefined) return -1;
	if (b.order !== undefined) return 1;
	return 0;
}
