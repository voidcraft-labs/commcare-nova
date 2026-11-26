import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type Column,
	resultsTileFieldCount,
	type TileCell,
	tileCellBottomEdge,
	tileRowLimit,
	type Uuid,
} from "@/lib/domain";
import { detailTabMembership } from "@/lib/domain/detailTabs";
import {
	fitTileCellIntoRows,
	nextFreeTilePlacement,
} from "@/lib/domain/tilePlacement";
import { spliceAfter } from "./mutations/sequence";

type MetaPatch = Extract<Mutation, { kind: "setCaseListMeta" }>["patch"];

/** Apply field visibility and layout together. A tab keeps its first surviving
 * field and an empty group goes away. New fields inherit the preceding group,
 * or the first group when inserted at the top. An explicit layout or grouping
 * in the same batch always wins.
 *
 * A tile has a row for each field it shows, at least six (`tileRowLimit`, the
 * rows CommCare HQ's own pages keep), so a field or tab leaving a screen can
 * leave a cell below the rows the tile now has. Each such cell is fitted back
 * in the same batch (`fitTileCellIntoRows`), on Results and on the Details
 * tile alike, unless the batch places that cell itself. Every derived edit is
 * in the mutation log. */
export function withDetailFieldLayout(
	moduleUuid: Uuid,
	config: CaseListConfig | undefined,
	mutations: readonly Mutation[],
): Mutation[] {
	const result = [...mutations];
	if (!config) return result;
	const changes = new Map<Uuid, boolean>();
	let sequence = config.detailColumnOrder;
	let grouped = false;
	let laidOut = false;
	let tabsAfter = config.detailTabs;
	for (const m of mutations) {
		if (m.kind === "setCaseListMeta" && m.uuid === moduleUuid) {
			if ("detailTabs" in m.patch) {
				grouped = true;
				tabsAfter = m.patch.detailTabs ?? undefined;
			}
			laidOut ||= "detailTile" in m.patch;
		}
		if (!("moduleUuid" in m) || m.moduleUuid !== moduleUuid) continue;
		if (m.kind === "addColumn") {
			sequence = spliceAfter(sequence, m.column.uuid, m.afterInDetail);
			changes.set(m.column.uuid, m.column.visibleInDetail !== false);
		} else if (m.kind === "removeColumn") changes.set(m.uuid, false);
		else if (
			m.kind === "updateColumn" &&
			m.visibilityPatch?.surface === "detail"
		)
			changes.set(m.uuid, m.visibilityPatch.visible);
	}
	const patch: MetaPatch = {};
	const before = new Set(
		config.columns
			.filter((c) => c.visibleInDetail !== false)
			.map((c) => c.uuid),
	);
	const shown = sequence.filter((id) => changes.get(id) ?? before.has(id));
	if (changes.size && config.detailTabs && !grouped) {
		const prior = detailTabMembership(config);
		const fields = new Map<Uuid, Uuid[]>();
		let owner = config.detailTabs[0];
		for (const id of shown) {
			owner = prior.get(id) ?? owner;
			const group = fields.get(owner.uuid);
			if (group) group.push(id);
			else fields.set(owner.uuid, [id]);
		}
		const tabs = config.detailTabs.flatMap((tab) => {
			const members = fields.get(tab.uuid);
			if (!members) return [];
			const { orderFields, ...body } = tab;
			const ordering = orderFields?.filter((id) => members.includes(id));
			return [
				{
					...body,
					startColumnUuid: members[0],
					...(ordering?.length && { orderFields: ordering }),
				},
			];
		});
		if (!deepEqual(tabs, config.detailTabs)) {
			patch.detailTabs = tabs.length ? tabs : null;
			tabsAfter = tabs.length ? tabs : undefined;
		}
	}
	if (config.detailTile && !laidOut) {
		const rows = tileRowLimit(
			shown.length + (tabsAfter === undefined ? 0 : tabsAfter.length),
		);
		const cells: Record<Uuid, TileCell> = { ...config.detailTile.cells };
		for (const [id, visible] of changes) if (!visible) delete cells[id];
		for (const [id, cell] of Object.entries(cells) as [Uuid, TileCell][]) {
			if (tileCellBottomEdge(cell) <= rows) continue;
			const others = Object.entries(cells)
				.filter(([other]) => other !== id)
				.map(([, other]) => other);
			const fitted = fitTileCellIntoRows(cell, others, rows);
			if (fitted) cells[id] = fitted;
		}
		for (const id of shown) {
			if (cells[id]) continue;
			const free = nextFreeTilePlacement(Object.values(cells), rows);
			if (free) cells[id] = free;
		}
		if (!deepEqual(cells, config.detailTile.cells))
			patch.detailTile = Object.keys(cells).length ? { cells } : null;
	}
	if (Object.keys(patch).length)
		result.push({ kind: "setCaseListMeta", uuid: moduleUuid, patch });
	result.push(...resultsTileRowFit(moduleUuid, config, mutations));
	return result;
}

/**
 * The placements that fit a Results tile's cells back inside its rows once
 * the batch has changed which fields the tile shows. Only a cell the batch
 * does not place itself moves, a saved place of a hidden field included,
 * since the gate holds every stored cell to the grid.
 */
function resultsTileRowFit(
	moduleUuid: Uuid,
	config: CaseListConfig,
	mutations: readonly Mutation[],
): Mutation[] {
	const columns = new Map<Uuid, Column>(
		config.columns.map((column) => [column.uuid, column]),
	);
	const placedByBatch = new Set<Uuid>();
	for (const m of mutations) {
		if (!("moduleUuid" in m) || m.moduleUuid !== moduleUuid) continue;
		if (m.kind === "addColumn") {
			columns.set(m.column.uuid, m.column as Column);
			if (m.column.tile !== undefined) placedByBatch.add(m.column.uuid);
		} else if (m.kind === "removeColumn") columns.delete(m.uuid);
		else if (m.kind === "updateColumn") {
			const current = columns.get(m.uuid);
			if (current === undefined) continue;
			if (m.tilePatch !== undefined) {
				placedByBatch.add(m.uuid);
				columns.set(m.uuid, {
					...current,
					tile: m.tilePatch ?? undefined,
				} as Column);
			} else if (m.visibilityPatch?.surface === "list") {
				const visible = m.visibilityPatch.visible;
				columns.set(m.uuid, {
					...current,
					visibleInList: visible,
					notOnList: visible
						? undefined
						: (m.visibilityPatch.notOnList ?? current.notOnList),
				} as Column);
			} else if (m.column !== undefined) {
				columns.set(m.uuid, {
					...current,
					...m.column,
					uuid: current.uuid,
					tile: current.tile,
					visibleInList: current.visibleInList,
					visibleInDetail: current.visibleInDetail,
					notOnList: current.notOnList,
				} as Column);
			}
		}
	}
	const after = [...columns.values()];
	const rows = tileRowLimit(resultsTileFieldCount({ columns: after }));
	const fitted: Mutation[] = [];
	for (const column of after) {
		const cell = column.tile;
		if (cell === undefined || placedByBatch.has(column.uuid)) continue;
		if (tileCellBottomEdge(cell) <= rows) continue;
		const placedOthers = [...columns.values()].filter(
			(other) => other.uuid !== column.uuid && other.tile !== undefined,
		);
		const cellsOf = (list: readonly Column[]) =>
			list.map((other) => other.tile as TileCell);
		// Clear of every saved place where it can be, so a hidden field shown
		// again lands where it was; otherwise clear of the fields shown.
		const place =
			fitTileCellIntoRows(cell, cellsOf(placedOthers), rows) ??
			fitTileCellIntoRows(
				cell,
				cellsOf(placedOthers.filter((other) => other.visibleInList !== false)),
				rows,
			);
		if (place === null) continue;
		columns.set(column.uuid, { ...column, tile: place } as Column);
		fitted.push({
			kind: "updateColumn",
			moduleUuid,
			uuid: column.uuid,
			tilePatch: place,
		});
	}
	return fitted;
}
