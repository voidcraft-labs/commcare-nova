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

"use client";

import type { Uuid } from "@/lib/domain";
import { bySortKey, sameSequenceByIdentity } from "../order/compare";
import { useBlueprintDocEq } from "./useBlueprintDoc";

/**
 * Reference-stable empty array for the "parent not found" case. A
 * module-level constant keeps the returned identity stable across renders
 * and across different hook callers that all land in the empty branch.
 */
const EMPTY_ORDER: readonly Uuid[] = Object.freeze([]);

/**
 * Uuids of a parent's direct children (form's top-level fields, or a
 * group/repeat's contained fields), in visual order.
 *
 * Materialize with `useField(uuid)` per child at the call site.
 */
export function useOrderedFields(parentUuid: Uuid): readonly Uuid[] {
	return useBlueprintDocEq((s) => {
		const order = s.fieldOrder[parentUuid];
		if (!order || order.length === 0) return EMPTY_ORDER;
		// Visual sequence is `sort-by-(order, uuid)`, not array position — a
		// same-parent reorder leaves the membership array untouched and only
		// changes a field's `order`, so the canvas re-sequences because this
		// hook sorts. The identity equality below keeps the reference stable
		// when the sorted order is unchanged.
		const fields = s.fields;
		return [...order].sort((a, b) =>
			bySortKey(fields[a] ?? {}, fields[b] ?? {}),
		);
	}, sameSequenceByIdentity);
}
