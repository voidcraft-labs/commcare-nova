/**
 * Shared planners for the column slots that have their own granular mutation
 * semantics. Builder auto-save and the SA/MCP tool boundary must make the same
 * content-vs-visibility decision or one surface can reintroduce stale full-body
 * writes that another surface already avoids.
 */

import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation, Uuid } from "@/lib/doc/types";
import type { Column } from "@/lib/domain";

type ColumnContent = NonNullable<
	Extract<Mutation, { kind: "updateColumn" }>["column"]
>;

/** The content owned by `updateColumn`; independent facets stay separate. */
export function columnContentSnapshot(column: Column): ColumnContent {
	const {
		uuid: _uuid,
		sort: _sort,
		tile: _tile,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		...content
	} = column;
	return content;
}

/** Plan one add, preserving independent Results and Details placements. */
export function columnAddMutation(
	moduleUuid: Uuid,
	column: Column,
	placement: {
		readonly afterInList: Uuid | null;
		readonly afterInDetail: Uuid | null;
	},
): Extract<Mutation, { kind: "addColumn" }> {
	return {
		kind: "addColumn",
		moduleUuid,
		column,
		afterInList: placement.afterInList,
		afterInDetail: placement.afterInDetail,
	};
}

/**
 * Plan the independently mergeable tile-placement slot.
 *
 * Placement is deliberately its own write rather than part of a content
 * update: an author dragging a cell and a peer relabelling the same column
 * are edits to different things and must merge, exactly as a move and a
 * relabel already do.
 */
export function columnTileMutations(
	current: Column,
	next: Column,
	moduleUuid: Uuid,
): Mutation[] {
	if (deepEqual(current.tile, next.tile)) return [];
	return [
		{
			kind: "updateColumn",
			moduleUuid,
			uuid: next.uuid,
			tilePatch: next.tile ?? null,
		},
	];
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
			column: columnContentSnapshot(next),
		});
	}
	mutations.push(...columnVisibilityMutations(current, next, moduleUuid));
	mutations.push(...columnSortMutations(current, next, moduleUuid));
	mutations.push(...columnTileMutations(current, next, moduleUuid));
	// No order arm: a column snapshot carries no place, so a content edit cannot
	// express a move and cannot clobber a concurrent one. Reordering is
	// `moveColumn` against the config's arrays, and nothing else.
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
		sort: _sort,
		visibleInList: _visibleInList,
		visibleInDetail: _visibleInDetail,
		tile: _tile,
		...content
	} = column;
	return content;
}
