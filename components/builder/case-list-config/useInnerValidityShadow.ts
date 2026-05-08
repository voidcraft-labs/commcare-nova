// components/builder/case-list-config/useInnerValidityShadow.ts
//
// Shared per-row validity shadow for drag-orderable list editors that
// host inner sub-editors per row. Today's consumers:
//
//   - `ColumnList` (in `DisplaySection.tsx`) — `Column` rows hosting
//     `ColumnEditor`'s applicability verdict + the inner
//     `ExpressionCardEditor` for calculated-arm columns.
//   - `SearchInputsSection` — `SearchInputDef` rows hosting
//     `ExpressionCardEditor` (default-value) +
//     `PredicateCardEditor` (advanced predicate) per row.
//
// Each surface has the same lifecycle: each row's inner editor fires
// `onValidityChange(boolean)` on every transition; the host AGGREGATES
// every row's verdict via logical-AND and propagates the result to its
// own parent via `onValidityChange(boolean)`.
//
// **Why row identity, not index.** A naive index-keyed boolean array
// looks "permutation-invariant" because the AND aggregation doesn't
// care about ordering at the reorder instant. But the next inner-flip
// AFTER a reorder writes against the row's NEW index, which is now
// occupied by a different row's stale verdict — the writer wins, the
// other row's stored verdict silently drops, and the aggregated
// verdict can land on `valid: false` even when every row is valid (or
// vice versa).
//
// Concrete walkthrough of the regression an index-keyed shadow allows:
//
//   - rows = [A_invalid, B_valid, C_valid]; shadow = [false, true, true]
//   - User reorders to [C, A, B]; shadow stays [false, true, true]
//     (the reorder doesn't touch the shadow).
//   - A's inner editor is now at index 1 (was 0).
//   - User fixes A; A's inner flips invalid→valid → `setRowValid(A, true)`.
//   - With INDEX keying: writes shadow[1] = true → no-op (was already
//     true from B's stale verdict at the original index 1). Aggregation
//     reads shadow[0] = false (now C's slot, but stale from A's old
//     verdict) → returns `valid: false`. Every row IS valid; the
//     editor reports invalid. User can't save.
//   - With ROW-IDENTITY keying: writes shadow.set(A, true). Aggregation
//     walks `rows` and reads each row's verdict via `shadow.get(row) ?? true`.
//     Returns `valid: true`. Correct.
//
// **WeakMap, not Map.** The shadow's keys are row OBJECT REFERENCES.
// `useReorderableList`'s splice contract preserves element references
// across reorder (the reordered array's entries are the SAME objects,
// just in a new order) — so the WeakMap entries survive reorder
// unchanged. When a row is removed (`onChange` emits a new array
// without that row), the original element becomes unreachable from
// React state and the WeakMap auto-collects its entry. No manual
// "remove this index" cleanup is needed; the GC handles it.
//
// Mutators rebuild the row through builders, which produce a NEW
// object reference. The new object has no shadow entry yet, so
// `shadow.get(newRow) ?? true` falls back to the "trivially valid"
// default — the inner editor's first verdict after the rebuild fires
// `setRowValid(newRow, ...)` and writes the real entry. This matches
// the index-keyed behavior on rebuilds (an unmounted-then-remounted
// inner editor fires its first verdict as part of its onMount path).

"use client";
import { useEffect, useMemo, useRef, useState } from "react";

interface UseInnerValidityShadowResult<T extends object> {
	/** Aggregated boolean — `true` when every row in `rows` is valid
	 *  (or hasn't fired a verdict yet — the default), `false` when at
	 *  least one row's most-recent verdict was `false`. Recomputed on
	 *  every render that bumps the version counter, which `setRowValid`
	 *  bumps whenever a row's verdict transitions. */
	readonly aggregatedValid: boolean;
	/** Record a row's most-recent inner-editor verdict. Bumps the
	 *  version counter (forcing a re-render) ONLY on actual
	 *  transitions — re-emitting the current verdict is a no-op. */
	readonly setRowValid: (row: T, valid: boolean) => void;
}

/**
 * Per-row validity shadow keyed by row identity. Accepts the editor's
 * current `rows` array; aggregates the per-row verdicts via logical-
 * AND and exposes a `setRowValid` setter for inner editors to call.
 *
 * The `rows` array is consumed by REFERENCE — entries that survive
 * reorder (the reorder hook splices existing references into the new
 * array order) carry their shadow entries forward; entries replaced
 * by builder mutations get a fresh "trivially valid" default until
 * the inner editor's first verdict lands.
 *
 * Default shape: a row with no shadow entry yet is treated as valid.
 * This matches the "fresh-mount row hasn't fired its first verdict"
 * behavior the index-keyed shape implemented; without the default
 * the host would briefly report `valid: false` on every newly-added
 * row before the inner editor's mount-time `useEffect` fired.
 */
export function useInnerValidityShadow<T extends object>(
	rows: readonly T[],
): UseInnerValidityShadowResult<T> {
	// WeakMap entries are auto-collected when the row reference leaves
	// scope (removed from `rows`). The `useRef` keeps the SAME WeakMap
	// instance across renders — without it, a fresh map per render
	// would lose every entry on the next render cycle.
	const shadowRef = useRef<WeakMap<T, boolean>>(new WeakMap());

	// Render-trigger counter — bumped on every transition. The
	// aggregation memo's deps include this counter so a write to the
	// WeakMap ref (which doesn't itself trigger React) re-runs the
	// aggregation against the freshly-updated ref.
	const [version, setVersion] = useState(0);

	const aggregatedValid = useMemo(() => {
		// Read the version so the dependency is explicit at the use
		// site rather than only at the deps array. Same load-bearing-
		// read idiom every other case-list-config editor uses for its
		// validity aggregation.
		void version;
		for (const row of rows) {
			const verdict = shadowRef.current.get(row) ?? true;
			if (verdict === false) return false;
		}
		return true;
	}, [rows, version]);

	const setRowValid = (row: T, valid: boolean): void => {
		const previous = shadowRef.current.get(row);
		// Skip the version bump on no-op transitions (re-emit of the
		// current verdict). React 19's `useState` bails out on
		// reference-equal updates anyway, but the explicit short-
		// circuit keeps the contract clear and avoids an unnecessary
		// `setVersion` call when an inner editor's `useEffect` fires
		// the same verdict it fired last render.
		if (previous === valid) return;
		shadowRef.current.set(row, valid);
		setVersion((v) => v + 1);
	};

	return { aggregatedValid, setRowValid };
}

interface UseValidityPropagatorArgs {
	/** The host's current aggregated verdict — computed from the
	 *  shadow (and any structural-error gates the host owns
	 *  upstream). */
	readonly isValid: boolean;
	/** The parent's `onValidityChange` callback. Stashed in a ref so
	 *  a fresh-each-render parent identity doesn't trip the
	 *  propagation effect on non-transitions. */
	readonly onValidityChange: ((valid: boolean) => void) | undefined;
}

/**
 * Standardized parent-validity propagation. Every list editor in
 * this package fires `onValidityChange(isValid)` on mount + on every
 * transition; the ref-stash defends against a fresh-each-render
 * parent callback identity tripping the effect on non-transitions.
 *
 * Centralized here so the boilerplate doesn't re-emerge per editor —
 * one shape, one place to fix.
 */
export function useValidityPropagator({
	isValid,
	onValidityChange,
}: UseValidityPropagatorArgs): void {
	const onValidityChangeRef = useRef(onValidityChange);
	onValidityChangeRef.current = onValidityChange;
	useEffect(() => {
		onValidityChangeRef.current?.(isValid);
	}, [isValid]);
}
