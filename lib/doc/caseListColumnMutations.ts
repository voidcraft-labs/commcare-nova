/**
 * Shared planners for the column slots that have their own granular mutation
 * semantics. Builder auto-save and the SA/MCP tool boundary must make the same
 * content-vs-visibility decision or one surface can reintroduce stale full-body
 * writes that another surface already avoids.
 */

import type { Mutation, Uuid } from "@/lib/doc/types";
import type { Column } from "@/lib/domain";

/** Compare only the column body owned by `updateColumn`. */
export function columnContentEqualIgnoringGranularSlots(
	a: Column,
	b: Column,
): boolean {
	return deepEqual(stripGranularSlots(a), stripGranularSlots(b));
}

/** Plan the independent Results/Details visibility changes between snapshots. */
export function columnVisibilityMutations(
	current: Column,
	next: Column,
	moduleUuid: Uuid,
): Mutation[] {
	const mutations: Mutation[] = [];
	if ((current.visibleInList !== false) !== (next.visibleInList !== false)) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			// Backward-compatible fallback: pre-deploy reducers know updateColumn
			// but ignore `visibilityPatch`, so they apply this desired full snapshot.
			column: next,
			visibilityPatch: {
				surface: "list",
				visible: next.visibleInList !== false,
			},
		});
	}
	if (
		(current.visibleInDetail !== false) !==
		(next.visibleInDetail !== false)
	) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			column: next,
			visibilityPatch: {
				surface: "detail",
				visible: next.visibleInDetail !== false,
			},
		});
	}
	return mutations;
}

function stripGranularSlots(column: Column): unknown {
	const {
		order: _order,
		listOrder: _listOrder,
		detailOrder: _detailOrder,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		...content
	} = column;
	return content;
}

/** Structural equality over the JSON-shaped values a Column can carry. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	const aArray = Array.isArray(a);
	const bArray = Array.isArray(b);
	if (aArray !== bArray) return false;
	if (aArray && bArray) {
		if (a.length !== b.length) return false;
		return a.every((value, index) => deepEqual(value, b[index]));
	}
	const aObject = a as Record<string, unknown>;
	const bObject = b as Record<string, unknown>;
	const aKeys = Object.keys(aObject);
	const bKeys = Object.keys(bObject);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) =>
			Object.hasOwn(bObject, key) && deepEqual(aObject[key], bObject[key]),
	);
}
