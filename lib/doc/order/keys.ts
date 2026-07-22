// lib/doc/order/keys.ts
//
// Total fractional-key primitives. An `order` key is a string over the
// BASE_62 digit alphabet, compared LEXICOGRAPHICALLY, that names an
// entity's absolute position in a sequence — `keyBetween(a, b)` returns a
// key that sorts strictly between two existing keys, so an add/move never
// renumbers its neighbors (the property that lets two editors reorder
// different things and merge by construction).
//
// The alphabet is `0-9A-Za-z` in ascending ASCII order, so lexicographic
// string comparison matches the fractional value `0.<key>` in base 62 —
// `"A5" < "AB"` as strings iff `0.A5 < 0.AB` as fractions. Keys carry no
// integer header (unlike the `fractional-indexing` package): a key is a
// pure fractional part, which keeps the algorithm small and TOTAL.
//
// `keyBetween` requires an ORDERED interval (`lo < hi`, treating a null bound
// as ±∞) and throws on a degenerate one (`lo >= hi`, both non-null) — the empty
// open interval has no key, so silently emitting one OUTSIDE it (the old
// `placeAfter` fallback) put an anchored insert in the wrong slot. A slot inside
// a run of equal-keyed siblings (a legitimate rested state — `bySortKey`
// tie-breaks equal keys on uuid) is not a degenerate interval: it's widened past
// the tied run to a distinct bound by `keysForSlot`, the ONE helper every
// insert-between gesture (SA anchor + builder drag) computes its interval
// through. A null upper bound is always a clean append, so append/prepend
// gestures never trip the precondition.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length; // 62

/** Digit char → value; -1 for a non-digit (never reached for our own keys). */
function val(ch: string): number {
	return DIGITS.indexOf(ch);
}

/**
 * The canonical numeric form of a key: trailing zero digits carry no
 * fractional value (`0.A0` ≡ `0.A`, `0.0` ≡ 0), so they are stripped before
 * any interval comparison or bisection. Nova-minted keys never end in the
 * zero digit, but every `order` slot is a wire-open string — an MCP client or
 * crafted auto-save PUT can persist `"0"` or `"A0"`, and judging THOSE
 * lexicographically against the numeric semantics mints keys OUTSIDE the
 * requested interval (`keyBetween(null, "0")` would return `"0V"`, which
 * sorts AFTER the `"0"` it was asked to precede — a drag-to-first that
 * silently lands second, forever, including on the wire).
 */
export function normalizedKey(key: string): string {
	let end = key.length;
	while (end > 0 && key[end - 1] === "0") end--;
	return key.slice(0, end);
}

/**
 * A key strictly greater than `0.tail` with an open upper bound (`< 1`).
 * Appending a single middle (non-zero) digit lands above `0.tail` because
 * of the extra digit, and below `1` because it is still a fractional part.
 * Used for "place after" and as the seed when both bounds are absent.
 */
function placeAfter(tail: string): string {
	return tail + DIGITS[BASE >> 1];
}

/**
 * A key `c` with `0.a < 0.c < 0.b`, where `a` (digits, possibly empty ≡ 0)
 * and `b` (non-empty digits) satisfy `0.a < 0.b`. Walks the shared prefix,
 * then either drops a midpoint digit into a gap of ≥ 2 or, for consecutive
 * digits, takes the lower digit and continues strictly above `a`'s tail —
 * which keeps `c < b` because `c` already diverges below `b` at this
 * position.
 */
function keyBetweenStrict(a: string, b: string): string {
	let prefix = "";
	for (let i = 0; ; i++) {
		const da = i < a.length ? val(a[i]) : 0;
		// `b` is a real, non-empty key and `0.a < 0.b`, so `b` never runs
		// out before `a` diverges below it; the `BASE` guard is defensive.
		const db = i < b.length ? val(b[i]) : BASE;
		if (da === db) {
			prefix += DIGITS[da];
			continue;
		}
		// `da < db` here (the shared prefix was consumed above).
		if (db - da >= 2) {
			return prefix + DIGITS[(da + db) >> 1];
		}
		// Consecutive digits: take the lower one, then any key strictly
		// above `a`'s remaining tail. `c[i] = da < db` already pins `c < b`.
		return prefix + DIGITS[da] + placeAfter(a.slice(i + 1));
	}
}

/**
 * A fractional key that sorts strictly between `a` and `b`.
 *
 * - `a` null ≡ "before everything" (0); `b` null ≡ "after everything" (1).
 * - Both null → a fresh middle key.
 * - PRECONDITION: `lo < hi` (both non-null). A degenerate/inverted interval
 *   (`lo >= hi`) has no key strictly between the bounds, so it THROWS — a
 *   caller that could see two display-adjacent siblings share a key computes
 *   its slot through {@link keysForSlot}, which widens past the tied run.
 *
 * The returned key never ends in the zero digit, so a later `keyBetween`
 * against it always has room to bisect.
 */
export function keyBetween(a: string | null, b: string | null): string {
	// Compare + bisect over the CANONICAL forms — a trailing-zero bound
	// (foreign-authored; Nova never mints one) is numerically identical to its
	// stripped twin, and the mint against normalized bounds still sorts
	// strictly between the RAW bounds lexicographically (a mint never ends in
	// the zero digit, and the only raw/canonical order divergence is a key
	// against its own zero-extensions).
	const loNorm = a === null ? "" : normalizedKey(a);
	const lo = loNorm.length > 0 ? loNorm : null;
	const hi = b !== null && b.length > 0 ? normalizedKey(b) : null;
	if (hi !== null && hi.length === 0) {
		throw new Error(
			`keyBetween's upper bound "${b}" is numerically ZERO (trailing zero ` +
				"digits carry no fractional value), and no key sorts strictly below " +
				"the fraction 0. Compute the slot through keysForSlot, which widens " +
				"past the zero-key run to a distinct bound before minting keys.",
		);
	}
	if (lo !== null && hi !== null && lo >= hi) {
		throw new Error(
			`keyBetween needs an ordered interval, but got lo="${a}" >= hi="${b}" ` +
				"(compared by numeric key value — trailing zero digits carry none). " +
				"Two display-adjacent siblings share an order key (a rested tie broken " +
				"on uuid), so there is no key strictly between them. Compute the slot " +
				"through keysForSlot, which widens past the whole tied run to a distinct " +
				"bound before minting keys.",
		);
	}
	if (hi === null) {
		// No upper bound: place after `lo` (or seed a base key when null).
		return placeAfter(lo ?? "");
	}
	// `hi` is a real key and `0.(lo ?? "") < 0.hi`.
	return keyBetweenStrict(lo ?? "", hi);
}

/**
 * `count` fractional keys strictly ASCENDING inside the open interval
 * (`lo`, `hi`) — the run a multi-item insert distributes between two
 * neighbors (either bound `null` for an edge insert). Input order is
 * preserved (the i-th caller item takes `keys[i]`). Empty for `count <= 0`.
 * Inherits `keyBetween`'s ordered-interval precondition, so it throws on a
 * degenerate `(lo, hi)` — callers route through {@link keysForSlot}.
 */
export function keysBetween(
	lo: string | null,
	hi: string | null,
	count: number,
): string[] {
	const keys: string[] = [];
	let low = lo;
	for (let i = 0; i < count; i++) {
		low = keyBetween(low, hi);
		keys.push(low);
	}
	return keys;
}

/**
 * `count` ascending keys in (`lo`, `hi`), minted as a balanced bisection tree.
 *
 * `keysBetween` intentionally preserves its historic left-to-right insertion
 * behavior: it is ideal for small multi-item gestures, but an unbounded append
 * run grows one digit per item. Bulk replacement needs a different shape — a
 * 5,000-row import must not manufacture a 5,000-character tail key. This helper
 * bisects the interval recursively, writes each midpoint into its final sorted
 * array slot, and therefore keeps depth logarithmic while preserving input
 * order (`items[i]` takes `keys[i]`).
 *
 * Empty for `count <= 0`. A positive count must be a safe integer and inherits
 * `keyBetween`'s ordered-interval precondition.
 */
export function balancedKeysBetween(
	lo: string | null,
	hi: string | null,
	count: number,
): string[] {
	if (count <= 0) return [];
	if (!Number.isSafeInteger(count)) {
		throw new RangeError("balancedKeysBetween count must be a safe integer");
	}
	const keys = new Array<string>(count);
	const fill = (
		start: number,
		end: number,
		lower: string | null,
		upper: string | null,
	) => {
		if (start >= end) return;
		const middle = start + Math.floor((end - start) / 2);
		const key = keyBetween(lower, upper);
		keys[middle] = key;
		fill(start, middle, lower, key);
		fill(middle + 1, end, key, upper);
	};
	fill(0, count, lo, hi);
	return keys;
}

/**
 * `count` keys for a NEW run landing at `slotIndex` in a list whose existing
 * keys are `sortedKeys` (ASCENDING). The interval is the slot's neighbors —
 * `sortedKeys[slotIndex - 1]` and `sortedKeys[slotIndex]` — EXCEPT when those
 * two collide (the slot sits inside a run of equal-keyed siblings): then `hi`
 * widens FORWARD past the whole tied run to the nearest DISTINCT key (null at
 * the end → a clean append), so the run lands AT a well-defined position after
 * the tie, and the interval handed to `keysBetween` is never degenerate.
 * `slotIndex` is clamped to `[0, sortedKeys.length]`. This is the ONE helper
 * every insert-between gesture (SA anchor + builder drag + duplicate) computes
 * its interval through, so they all agree at a collision.
 */
export function keysForSlot(
	sortedKeys: readonly string[],
	slotIndex: number,
	count: number,
): string[] {
	const clamped = Math.max(0, Math.min(slotIndex, sortedKeys.length));
	const lo = clamped > 0 ? sortedKeys[clamped - 1] : null;
	let hiIndex = clamped;
	let hi = hiIndex < sortedKeys.length ? sortedKeys[hiIndex] : null;
	// A tie is NUMERIC key equality, so `"0"` vs `"00"` (and the zero-key floor
	// against a null lo — nothing can sort strictly below the fraction 0) are
	// ties too, not just byte-equal keys. Nova never mints such keys, but the
	// `order` slots are wire-open, so a foreign-authored sibling must widen
	// rather than hand `keyBetween` a numerically-degenerate interval.
	const tied = lo === null ? "" : normalizedKey(lo);
	if (hi !== null && normalizedKey(hi) === tied) {
		// Widen past the tied run to the first strictly-greater key (null at
		// the list end). `lo` stays the tied value, so the new run sorts after
		// every equal-keyed sibling and before the first distinct one above.
		while (
			hiIndex < sortedKeys.length &&
			normalizedKey(sortedKeys[hiIndex]) === tied
		) {
			hiIndex++;
		}
		hi = hiIndex < sortedKeys.length ? sortedKeys[hiIndex] : null;
	}
	return keysBetween(lo, hi, count);
}

/**
 * The key for an item inserted at `index` into a list whose existing keys
 * are `orderedKeys`, given in ASCENDING sorted order. Places the new key
 * between the neighbors on either side of the slot (null past either end),
 * widening past a collision run via {@link keysForSlot} so equal-keyed
 * neighbors never yield a degenerate interval. `index` is clamped.
 */
export function deriveKeyAtIndex(orderedKeys: string[], index: number): string {
	return keysForSlot(orderedKeys, index, 1)[0];
}

/**
 * The single fractional key for a direct move to `toIndex` among
 * `siblingKeys` — the resolved order keys of the OTHER rows in display order,
 * with the moved row already removed. A row that resolves no key contributes
 * `undefined`.
 *
 * Hydration normally backfills every generic key, so each resolved key is
 * present. Counting only the DEFINED keys before the requested slot is a
 * defensive legacy fallback: a keyed row sorts ahead of a keyless one, so this
 * lands the moved row at the closest representable slot without resequencing
 * the keyless siblings. Both the Search-input and the Results/Details column
 * move planners share this one edge-case home.
 */
export function plannedMoveSlotKey(
	siblingKeys: readonly (string | undefined)[],
	toIndex: number,
): string {
	const definedKeys = siblingKeys.filter(
		(order): order is string => order !== undefined,
	);
	const keySlot = siblingKeys
		.slice(0, toIndex)
		.filter((order): order is string => order !== undefined).length;
	return deriveKeyAtIndex(definedKeys, keySlot);
}
