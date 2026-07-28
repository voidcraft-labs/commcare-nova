/**
 * Where a field lands under a parent — the one place a requested slot becomes a
 * placement.
 *
 * Shared by the builder's add/move dispatches and the SA's `moveField` tool so
 * both surfaces resolve the same gesture to the same landing — the uuid the
 * field follows, which a peer's concurrent insert cannot shift.
 */

import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

/** A requested slot. All three are optional; absent means append. */
export interface FieldSlotRequest {
	readonly index?: number;
	readonly beforeUuid?: Uuid;
	readonly afterUuid?: Uuid;
}

/**
 * The uuid the field should follow under `parentUuid`, or `null` for first.
 *
 * `exclude` drops the moving field from the neighbour set, because a same-parent
 * reorder places it among the OTHER siblings — counting itself would shift every
 * index past its current position by one.
 */
export function fieldSlotAfter(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	slot: FieldSlotRequest,
	exclude?: Uuid,
): Uuid | null {
	const siblings = orderedFieldUuids(doc, parentUuid).filter(
		(uuid) => uuid !== exclude,
	);
	if (slot.afterUuid !== undefined) return slot.afterUuid;
	if (slot.beforeUuid !== undefined) {
		const at = siblings.indexOf(slot.beforeUuid);
		// An anchor that is not a sibling appends rather than throwing: a peer may
		// have moved or removed it between the gesture and the dispatch.
		if (at < 0) return siblings.at(-1) ?? null;
		return at === 0 ? null : (siblings[at - 1] as Uuid);
	}
	const index = slot.index ?? siblings.length;
	const clamped = Math.max(0, Math.min(index, siblings.length));
	return clamped === 0 ? null : (siblings[clamped - 1] as Uuid);
}
