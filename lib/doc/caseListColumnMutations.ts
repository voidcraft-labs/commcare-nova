/**
 * Shared planners for the column slots that have their own granular mutation
 * semantics. Builder auto-save and the SA/MCP tool boundary must make the same
 * content-vs-visibility decision or one surface can reintroduce stale full-body
 * writes that another surface already avoids.
 */

import { deepEqual } from "@/lib/doc/deepEqual";
import { columnSurfaceOrderMutation } from "@/lib/doc/order/columnSurface";
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { Column } from "@/lib/domain";

/**
 * Origin/main's strict nested `columnSchema` predates the two surface-order
 * keys. Keep every fallback snapshot parseable by an old PUT handler; the new
 * keys travel only in optional top-level extensions on known mutation kinds.
 */
export function legacyCompatibleColumnSnapshot(column: Column): Column {
	const {
		listOrder: _listOrder,
		detailOrder: _detailOrder,
		...legacyColumn
	} = column;
	return legacyColumn as Column;
}

/** Plan one backward-compatible add, preserving independent orders for new reducers. */
export function columnAddMutation(
	moduleUuid: Uuid,
	column: Column,
): Extract<Mutation, { kind: "addColumn" }> {
	const surfaceOrders =
		column.listOrder === undefined && column.detailOrder === undefined
			? undefined
			: {
					...(column.listOrder !== undefined && {
						listOrder: column.listOrder,
					}),
					...(column.detailOrder !== undefined && {
						detailOrder: column.detailOrder,
					}),
				};
	return {
		kind: "addColumn",
		moduleUuid,
		column: legacyCompatibleColumnSnapshot(column),
		...(surfaceOrders !== undefined && { surfaceOrders }),
	};
}

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
			// but ignore `visibilityPatch`, so they apply this desired old-shape
			// snapshot. Surface-order keys stay top-level on their own move events;
			// origin/main's strict nested column schema would reject them here.
			column: legacyCompatibleColumnSnapshot(next),
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
			column: legacyCompatibleColumnSnapshot(next),
			visibilityPatch: {
				surface: "detail",
				visible: next.visibleInDetail !== false,
			},
		});
	}
	return mutations;
}

/** Plan the independently mergeable sort slot. */
export function columnSortMutations(
	current: Column,
	next: Column,
	moduleUuid: Uuid,
): Mutation[] {
	if (deepEqual(current.sort, next.sort)) return [];
	return [
		{
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			column: legacyCompatibleColumnSnapshot(next),
			sortPatch: next.sort ?? null,
		},
	];
}

/**
 * Plan one workspace row replacement into independently mergeable content,
 * visibility, and Results/Details order writes. The reducer resolves every
 * mutation against the fresh column, so a stale inspector edit cannot erase a
 * peer's change to another slot.
 */
export function columnSnapshotMutations(
	moduleUuid: Uuid,
	current: Column,
	replacement: Column,
): Mutation[] {
	const next = { ...replacement, uuid: current.uuid } as Column;
	const mutations: Mutation[] = [];
	if (!columnContentEqualIgnoringGranularSlots(current, next)) {
		mutations.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: current.uuid,
			column: legacyCompatibleColumnSnapshot(next),
			preserveVisibility: true,
			preserveSort: true,
		});
	}
	mutations.push(...columnVisibilityMutations(current, next, moduleUuid));
	mutations.push(...columnSortMutations(current, next, moduleUuid));
	if (current.listOrder !== next.listOrder) {
		mutations.push(
			columnSurfaceOrderMutation({
				moduleUuid,
				column: current,
				surface: "list",
				order: next.listOrder ?? null,
			}),
		);
	}
	if (current.detailOrder !== next.detailOrder) {
		mutations.push(
			columnSurfaceOrderMutation({
				moduleUuid,
				column: current,
				surface: "detail",
				order: next.detailOrder ?? null,
			}),
		);
	}
	return mutations;
}

/**
 * Diff an editor-produced column snapshot without treating absence as remove.
 * Workspace sort/visibility editors own only the rows they changed; peer-added
 * rows absent from a stale snapshot must survive replay.
 */
export function columnSnapshotBatchMutations(
	moduleUuid: Uuid,
	current: readonly Column[],
	next: readonly Column[],
): Mutation[] {
	const currentByUuid = new Map(
		current.map((column) => [column.uuid, column] as const),
	);
	return next.flatMap((column) => {
		const existing = currentByUuid.get(column.uuid);
		return existing === undefined
			? []
			: columnSnapshotMutations(moduleUuid, existing, column);
	});
}

function stripGranularSlots(column: Column): unknown {
	const {
		order: _order,
		listOrder: _listOrder,
		detailOrder: _detailOrder,
		sort: _sort,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		...content
	} = column;
	return content;
}
