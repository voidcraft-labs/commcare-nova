"use client";

import { useMemo } from "react";

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
import { useBlueprintDocEq, useBlueprintDocShallow } from "./useBlueprintDoc";

/** Large forms start summarized in the structure tree. Rendering hundreds of
 * interactive rows before the Builder can respond is both slower and less
 * useful than showing the form-level outline first. The selected form is
 * always expanded by AppTree. */
export const LARGE_FORM_AUTO_COLLAPSE_THRESHOLD = 50;

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

/** Form and nested-container uuids whose large form should start summarized.
 * Collapsing nested groups as well as the form means opening a large form shows
 * a useful outline instead of immediately materializing every descendant row.
 * The projection is stable across unrelated edits. */
export function useLargeFormInitialCollapsedUuids(): ReadonlySet<Uuid> {
	const { forms, fieldOrder } = useBlueprintDocShallow((doc) => ({
		forms: doc.forms,
		fieldOrder: doc.fieldOrder,
	}));
	return useMemo(() => {
		const collapsed = new Set<Uuid>();
		for (const { uuid: formUuid } of Object.values(forms)) {
			let count = 0;
			const pending = [...(fieldOrder[formUuid] ?? [])];
			const containers: Uuid[] = [formUuid];
			while (pending.length > 0) {
				const uuid = pending.pop();
				if (uuid === undefined) break;
				count += 1;
				const children = fieldOrder[uuid] ?? [];
				if (children.length > 0) containers.push(uuid);
				pending.push(...children);
			}
			if (count >= LARGE_FORM_AUTO_COLLAPSE_THRESHOLD) {
				for (const uuid of containers) collapsed.add(uuid);
			}
		}
		return collapsed;
	}, [fieldOrder, forms]);
}
