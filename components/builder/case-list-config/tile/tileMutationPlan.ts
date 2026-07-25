// components/builder/case-list-config/tile/tileMutationPlan.ts
//
// Every tile edit as a gated batch. Two rules shape all of them:
//
//   - **Turning the tile on lands a working layout.** The switch and
//     the placements for every field that needs one commit together, so
//     an author never lands on an empty grid to repair. Fields that
//     already hold a place keep it.
//   - **Turning the tile off keeps every cell.** A stored cell with no
//     layout is inert and valid, so switching back restores the drawing
//     the author made. Nothing here ever discards a placement the author
//     did not ask to discard.
//
// Placement writes go through `columnTileMutations`, the shared planner
// that makes a cell its own independently mergeable write — a peer
// relabelling the same column while this author drags it are edits to
// different things and must merge.

import { columnTileMutations } from "@/lib/doc/caseListColumnMutations";
import type { Mutation, Uuid } from "@/lib/doc/types";
import {
	type CaseTileLayout,
	type Column,
	type TileCell,
	tileCell,
} from "@/lib/domain";
import {
	nextFreeTilePlacement,
	type TileGeometry,
	tileMembership,
	tileMemberUuids,
} from "./tileModel";
import {
	assignTileArrangement,
	seedTileArrangement,
	TILE_MAX_FIELDS,
	type TilePreset,
} from "./tilePresets";

export type TilePlanOutcome =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| { readonly ok: false; readonly reason: string };

/** Write one column's placement, or clear it with `undefined`. */
export function tileCellMutations(
	moduleUuid: Uuid,
	column: Column,
	cell: TileCell | undefined,
): readonly Mutation[] {
	return columnTileMutations(
		column,
		cell === undefined
			? ({ ...column, tile: undefined } as Column)
			: ({ ...column, tile: cell } as Column),
		moduleUuid,
	);
}

/**
 * Turn the tile layout on, placing every field that needs a place in the
 * same batch.
 *
 * A tile with nothing on it yet is seeded whole, so it opens as a
 * readable arrangement rather than a pile in one corner. A tile that
 * already carries places keeps them and fills only the gaps.
 */
export function planTileLayoutEnable(args: {
	readonly moduleUuid: Uuid;
	readonly columns: readonly Column[];
}): TilePlanOutcome {
	const { moduleUuid, columns } = args;
	const { placed, unplaced } = tileMembership(columns);
	const memberCount = placed.length + unplaced.length;

	if (memberCount === 0) {
		return {
			ok: false,
			reason:
				"Add information to Results before turning on the tile — a tile needs at least one field to lay out.",
		};
	}

	const byUuid = new Map(columns.map((column) => [column.uuid, column]));
	const mutations: Mutation[] = [];

	if (placed.length === 0) {
		const arrangement = seedTileArrangement(memberCount);
		if (arrangement === null) {
			return { ok: false, reason: tooManyFieldsReason(memberCount) };
		}
		const assigned = assignTileArrangement(
			unplaced.map((entry) => entry.uuid),
			arrangement,
		);
		for (const [uuid, geometry] of assigned) {
			const column = byUuid.get(uuid);
			if (column === undefined) continue;
			mutations.push(
				...tileCellMutations(moduleUuid, column, cellOf(geometry)),
			);
		}
	} else {
		const occupied: TileCell[] = placed.map((entry) => entry.cell);
		for (const vacancy of unplaced) {
			const column = byUuid.get(vacancy.uuid);
			if (column === undefined) continue;
			const free = nextFreeTilePlacement(occupied);
			if (free === null) {
				return {
					ok: false,
					reason: `There is no room left on the tile for ${vacancy.label}. Make another field smaller, or hide this one from Results.`,
				};
			}
			occupied.push(free);
			mutations.push(...tileCellMutations(moduleUuid, column, free));
		}
	}

	mutations.push({
		kind: "setCaseListMeta",
		uuid: moduleUuid,
		patch: {},
		tilePatch: {},
	});
	return { ok: true, mutations };
}

/**
 * Turn the tile layout off. Only the layout slot clears — every cell
 * stays exactly where the author put it, inert until the tile comes
 * back.
 */
export function planTileLayoutDisable(moduleUuid: Uuid): readonly Mutation[] {
	return [
		{ kind: "setCaseListMeta", uuid: moduleUuid, patch: {}, tilePatch: null },
	];
}

/**
 * Keep the tile on screen above this module's forms, or stop doing so.
 *
 * `tilePatch` replaces the layout object wholesale, so this rebuilds it
 * from the current one rather than writing a bare `{ persistOnForms }`.
 * The layout carries exactly one slot today and the two spellings are
 * identical — but a second slot added later would be silently erased by
 * every toggle of this switch, and that failure is invisible until an
 * author notices a setting gone.
 */
export function planTilePersistOnForms(
	moduleUuid: Uuid,
	persist: boolean,
	current: CaseTileLayout | undefined,
): readonly Mutation[] {
	const { persistOnForms: _cleared, ...rest } = current ?? {};
	return [
		{
			kind: "setCaseListMeta",
			uuid: moduleUuid,
			patch: {},
			tilePatch: persist ? { ...rest, persistOnForms: true } : rest,
		},
	];
}

/**
 * Rearrange every field on the tile into one preset shape, keeping each
 * cell's alignment, text size, border, and shading. A preset decides
 * where a field sits, never how it looks.
 */
export function planTilePreset(args: {
	readonly moduleUuid: Uuid;
	readonly columns: readonly Column[];
	readonly preset: TilePreset;
}): TilePlanOutcome {
	const { moduleUuid, columns, preset } = args;
	const members = tileMemberUuids(columns);
	const arrangement = preset.arrange(members.length);
	if (arrangement === null) {
		return {
			ok: false,
			reason: `${preset.label} has no room for ${members.length} ${members.length === 1 ? "field" : "fields"}.`,
		};
	}

	const byUuid = new Map(columns.map((column) => [column.uuid, column]));
	const mutations: Mutation[] = [];
	for (const [uuid, geometry] of assignTileArrangement(members, arrangement)) {
		const column = byUuid.get(uuid);
		if (column === undefined) continue;
		const next =
			column.tile === undefined
				? cellOf(geometry)
				: { ...column.tile, ...geometry };
		mutations.push(...tileCellMutations(moduleUuid, column, next));
	}
	return { ok: true, mutations };
}

/** Give one field a place on the tile, in the first free space. */
export function planTilePlaceField(args: {
	readonly moduleUuid: Uuid;
	readonly columns: readonly Column[];
	readonly uuid: Uuid;
}): TilePlanOutcome {
	const { moduleUuid, columns, uuid } = args;
	const column = columns.find((candidate) => candidate.uuid === uuid);
	if (column === undefined) {
		return {
			ok: false,
			reason:
				"That field is no longer in this case list. Reopen Results to see what it shows now.",
		};
	}
	const occupied = tileMembership(columns)
		.placed.filter((entry) => entry.uuid !== uuid)
		.map((entry) => entry.cell);
	const free = nextFreeTilePlacement(occupied);
	if (free === null) {
		return {
			ok: false,
			reason:
				"There is no room left on the tile. Make another field smaller first.",
		};
	}
	return { ok: true, mutations: tileCellMutations(moduleUuid, column, free) };
}

function tooManyFieldsReason(memberCount: number): string {
	return `A tile has room for ${TILE_MAX_FIELDS} fields, and Results shows ${memberCount}. Hide some information from Results first.`;
}

function cellOf(geometry: TileGeometry): TileCell {
	return tileCell(geometry.x, geometry.y, geometry.width, geometry.height);
}
