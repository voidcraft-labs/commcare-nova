"use client";

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

import { sameSequenceByIdentity } from "@/lib/doc/sequenceEquality";
import type { Uuid } from "@/lib/domain";
import { useBlueprintDocEq } from "./useBlueprintDoc";

/**
 * Reference-stable empty array for the "parent not found" case. A
 * module-level constant keeps the returned identity stable across renders
 * and across different hook callers that all land in the empty branch.
 */
const EMPTY_ORDER: readonly Uuid[] = Object.freeze([]);

/**
 * Uuids of a parent's direct children (form's top-level fields, or a
 * group/repeat's contained fields), in visual order. No parent (a screen
 * that has not resolved its form yet) reads as the empty sequence, so a
 * caller never has to invent an identity to keep hook order.
 *
 * Materialize with `useField(uuid)` per child at the call site.
 */
export function useOrderedFields(
	parentUuid: Uuid | undefined,
): readonly Uuid[] {
	return useBlueprintDocEq((s) => {
		const order =
			parentUuid === undefined ? undefined : s.fieldOrder[parentUuid];
		if (!order || order.length === 0) return EMPTY_ORDER;
		// The membership array IS the visual sequence, so there is nothing to
		// derive. The identity equality below still keeps the reference stable
		// when an unrelated edit leaves this sequence untouched, so `React.memo`
		// consumers don't churn.
		return [...order];
	}, sameSequenceByIdentity);
}
