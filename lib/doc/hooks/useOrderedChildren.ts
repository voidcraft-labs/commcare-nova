/**
 * Return the ordered child UUIDs of a form or group/repeat.
 *
 * Returns uuids — not materialized `Field` objects — so the subscription
 * only re-runs when the parent's ordering array changes. Materializing the
 * whole `fields` map here (the previous design) forced every container to
 * re-render on every field edit anywhere in the doc, because Immer
 * publishes a new top-level `fields` reference on every mutation.
 *
 * Consumers that need entity data call `useField(uuid)` per child — those
 * per-uuid subscriptions isolate re-renders to the specific child that
 * actually changed.
 *
 * Identity stability: Immer may allocate a fresh ordering array even when
 * the parent's entry is unchanged (sibling parents' edits re-key the
 * `fieldOrder` map). A custom equality function compares elements by
 * reference so consumers see the prior array reference when contents are
 * unchanged — stable enough for `React.memo` without spurious churn.
 */

import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDocEq } from "./useBlueprintDoc";

/**
 * Reference-stable empty array for the "parent not found" case. A
 * module-level constant keeps the returned identity stable across renders
 * and across different hook callers that all land in the empty branch.
 */
const EMPTY_ORDER: readonly Uuid[] = Object.freeze([]);

/**
 * Element-wise identity equality. Returns true iff both arrays are the
 * same length and every index holds the identical reference. zustand's
 * `useStoreWithEqualityFn` returns the prior snapshot when this predicate
 * holds, preserving array identity for consumers.
 */
function arraysEqualByIdentity<T>(a: readonly T[], b: readonly T[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Uuids of a parent's direct children (form's top-level fields, or a
 * group/repeat's contained fields), in visual order.
 *
 * Materialize with `useField(uuid)` per child at the call site.
 */
export function useOrderedChildren(parentUuid: Uuid): readonly Uuid[] {
	return useBlueprintDocEq(
		(s) => s.fieldOrder[parentUuid] ?? EMPTY_ORDER,
		arraysEqualByIdentity,
	);
}
