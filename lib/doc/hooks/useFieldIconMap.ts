/**
 * Field-count hooks used by the AppTree rows.
 *
 * `useFormDescendantCount` + the underlying pure `countFieldsFromOrder`
 * helper live here because they walk a form's field subtree. Keeping the
 * pure walker as a primitive-returning function lets Zustand's equality
 * check skip re-renders when unrelated forms' field lists change.
 *
 * Lives in `lib/doc/hooks/` because these are narrow doc-store subscription
 * hooks, not AppTree-presentation utilities. Colocating them with the other
 * `lib/doc/hooks/*` entries keeps the boundary rule (components import hooks,
 * never the raw store) trivially enforceable.
 */

"use client";

import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";

/**
 * Count fields recursively under a form or group. Pure, primitive
 * result — safe to call inside a Zustand selector so the caller re-renders
 * only when its own count actually changes.
 */
export function countFieldsFromOrder(
	parentId: Uuid,
	fieldOrder: Record<Uuid, Uuid[]>,
): number {
	let count = 0;
	function walk(pid: Uuid) {
		const uuids = fieldOrder[pid] ?? [];
		count += uuids.length;
		for (const uuid of uuids) {
			walk(uuid);
		}
	}
	walk(parentId);
	return count;
}

/**
 * Recursive descendant count for a form or container. Subscribes to the
 * whole `fieldOrder` map (Immer-stable reference) and walks the subtree
 * via `countFieldsFromOrder`. Returns a number primitive, so the
 * default `Object.is` comparison inside `useBlueprintDoc` re-renders
 * the caller only when the count actually changes.
 *
 * Accepts `Uuid | undefined` so call sites that derive the parent uuid
 * from an optional URL selection don't need to guard the hook call.
 * Returns 0 when `parentUuid` is missing.
 */
export function useFormDescendantCount(parentUuid: Uuid | undefined): number {
	return useBlueprintDoc((s) =>
		parentUuid ? countFieldsFromOrder(parentUuid, s.fieldOrder) : 0,
	);
}
