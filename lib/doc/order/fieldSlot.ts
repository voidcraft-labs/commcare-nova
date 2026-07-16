/**
 * The one slot → field-order-key computation every insert-or-move
 * gesture shares — the builder's drag/insert dispatches and the SA's
 * `moveField` tool. Divergent copies of this arithmetic are themselves
 * an order-key-consistency risk (see `order/append.ts`), so it lives in
 * one place: both surfaces minting a key for the same gesture must land
 * the same key.
 */

import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { keysForSlot } from "@/lib/doc/order/keys";
import type { BlueprintDoc, Uuid } from "@/lib/domain";

/**
 * Compute the absolute fractional `order` key for a field landing in (or
 * moving within) `parentUuid` at the requested slot — `index` (clamped) wins,
 * else `beforeUuid` / `afterUuid` resolves to a slot in the parent's DISPLAY
 * sequence (`sort-by-(order, uuid)`), default append. `excludeUuid` drops the
 * field being moved from the neighbor set so a same-parent reorder keys between
 * the OTHER siblings. The key is computed against the live doc and the
 * reducer stores it verbatim — never recomputed from an index server-side.
 */
export function orderKeyForFieldSlot(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	slot: { index?: number; beforeUuid?: Uuid; afterUuid?: Uuid },
	excludeUuid?: Uuid,
): string {
	const siblings = orderedFieldUuids(doc, parentUuid).filter(
		(u) => u !== excludeUuid,
	);
	let index = siblings.length;
	if (slot.index !== undefined) {
		index = Math.max(0, Math.min(slot.index, siblings.length));
	} else if (slot.beforeUuid) {
		const i = siblings.indexOf(slot.beforeUuid);
		if (i >= 0) index = i;
	} else if (slot.afterUuid) {
		const i = siblings.indexOf(slot.afterUuid);
		if (i >= 0) index = i + 1;
	}
	// Route through the shared slot helper so a collision (two display-adjacent
	// siblings sharing a key) widens past the tied run to a well-defined slot —
	// identically on every surface that mints a key for the same gesture.
	const siblingKeys = siblings
		.map((u) => doc.fields[u]?.order)
		.filter((o): o is string => o !== undefined);
	return keysForSlot(siblingKeys, index, 1)[0];
}
