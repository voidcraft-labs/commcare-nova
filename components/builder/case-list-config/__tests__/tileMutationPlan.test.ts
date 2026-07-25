// components/builder/case-list-config/__tests__/tileMutationPlan.test.ts
//
// The batches behind the arrangement switch. Two invariants carry the
// whole feature: turning the tile on lands its placements in the SAME
// batch as the switch (so the grid an author arrives at works), and
// turning it off touches nothing but the layout slot (so the drawing
// comes back intact).

import { describe, expect, it } from "vitest";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type Column, plainColumn, tileCell } from "@/lib/domain";
import {
	planTileLayoutDisable,
	planTileLayoutEnable,
	planTilePersistOnForms,
	planTilePlaceField,
	planTilePreset,
	tileCellMutations,
} from "../tile/tileMutationPlan";
import { TILE_PRESETS } from "../tile/tilePresets";

const MODULE = asUuid("module-1");

function column(
	id: string,
	header: string,
	slots: Partial<Column> = {},
): Column {
	return { ...plainColumn(asUuid(id), id, header), ...slots } as Column;
}

/** The placement each `updateColumn` in a batch writes, keyed by field. */
function placements(mutations: readonly Mutation[]) {
	const written = new Map<string, unknown>();
	for (const mutation of mutations) {
		if (mutation.kind !== "updateColumn") continue;
		written.set(mutation.uuid, mutation.tilePatch);
	}
	return written;
}

function layoutWrites(mutations: readonly Mutation[]) {
	return mutations.filter((mutation) => mutation.kind === "setCaseListMeta");
}

describe("planTileLayoutEnable", () => {
	it("seeds every field and switches the layout on in one batch", () => {
		const plan = planTileLayoutEnable({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", { listOrder: "a" }),
				column("village", "Village", { listOrder: "b" }),
			],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		expect(placements(plan.mutations)).toEqual(
			new Map([
				["name", tileCell(0, 0, 12, 1)],
				["village", tileCell(0, 1, 12, 1)],
			]),
		);
		// The layout switch lands last, so the doc is never momentarily a
		// tile with nothing on it.
		const layout = layoutWrites(plan.mutations);
		expect(layout).toHaveLength(1);
		expect(plan.mutations.at(-1)).toBe(layout[0]);
		expect(layout[0]).toEqual({
			kind: "setCaseListMeta",
			uuid: MODULE,
			patch: {},
			tilePatch: {},
		});
	});

	it("keeps places an author already drew and only fills the gaps", () => {
		const plan = planTileLayoutEnable({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", {
					listOrder: "a",
					tile: tileCell(0, 3, 6, 2, { fontSize: "large" }),
				}),
				column("village", "Village", { listOrder: "b" }),
			],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const written = placements(plan.mutations);
		expect(written.has("name")).toBe(false);
		expect(written.get("village")).toEqual(tileCell(0, 0, 12, 1));
	});

	it("leaves a hidden default-order field unplaced — it draws nothing", () => {
		// It reaches the wire as CommCare's reserved zero-width carrier, so
		// it needs no square on the tile.
		const plan = planTileLayoutEnable({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", { listOrder: "a" }),
				column("registered", "Registered on", {
					listOrder: "b",
					visibleInList: false,
					sort: { direction: "asc", priority: 1 },
				}),
			],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect([...placements(plan.mutations).keys()]).toEqual(["name"]);
	});

	it("leaves a Details-only field alone — the tile does not carry it", () => {
		const plan = planTileLayoutEnable({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", { listOrder: "a" }),
				column("notes", "Notes", { listOrder: "b", visibleInList: false }),
			],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect([...placements(plan.mutations).keys()]).toEqual(["name"]);
	});

	it("refuses an empty Results screen with a reason, not an empty grid", () => {
		const plan = planTileLayoutEnable({ moduleUuid: MODULE, columns: [] });
		expect(plan.ok).toBe(false);
		expect(plan.ok === false && plan.reason).toBe(
			"Add information to Results before turning on the tile — a tile needs at least one field to lay out.",
		);
	});

	it("refuses more fields than a tile can hold, and says how many", () => {
		const columns = Array.from({ length: 145 }, (_unused, index) =>
			column(`c${index}`, `Field ${index}`, {
				listOrder: String(index).padStart(4, "0"),
			}),
		);
		const plan = planTileLayoutEnable({ moduleUuid: MODULE, columns });
		expect(plan.ok).toBe(false);
		expect(plan.ok === false && plan.reason).toBe(
			"A tile has room for 144 fields, and Results shows 145. Hide some information from Results first.",
		);
	});

	it("refuses to squeeze a field into a tile a prior drawing already filled", () => {
		const plan = planTileLayoutEnable({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", {
					listOrder: "a",
					tile: tileCell(0, 0, 12, 12),
				}),
				column("village", "Village", { listOrder: "b" }),
			],
		});
		expect(plan.ok).toBe(false);
		expect(plan.ok === false && plan.reason).toBe(
			"There is no room left on the tile for Village. Make another field smaller, or hide this one from Results.",
		);
	});
});

describe("planTileLayoutDisable", () => {
	it("clears the layout and touches nothing else, so every cell survives", () => {
		expect(planTileLayoutDisable(MODULE)).toEqual([
			{ kind: "setCaseListMeta", uuid: MODULE, patch: {}, tilePatch: null },
		]);
	});
});

describe("planTilePersistOnForms", () => {
	it("stores the only value the slot has, and clears by omission", () => {
		expect(planTilePersistOnForms(MODULE, true)).toEqual([
			{
				kind: "setCaseListMeta",
				uuid: MODULE,
				patch: {},
				tilePatch: { persistOnForms: true },
			},
		]);
		expect(planTilePersistOnForms(MODULE, false)).toEqual([
			{ kind: "setCaseListMeta", uuid: MODULE, patch: {}, tilePatch: {} },
		]);
	});
});

describe("planTilePreset", () => {
	const preset = TILE_PRESETS[1];

	it("rearranges every member and keeps each cell's presentation", () => {
		expect(preset).toBeDefined();
		if (preset === undefined) return;
		const plan = planTilePreset({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", {
					listOrder: "a",
					tile: tileCell(0, 4, 3, 1, {
						fontSize: "large",
						horizontalAlign: "center",
					}),
				}),
				column("village", "Village", { listOrder: "b" }),
			],
			preset,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(placements(plan.mutations)).toEqual(
			new Map([
				[
					"name",
					tileCell(0, 0, 6, 1, {
						fontSize: "large",
						horizontalAlign: "center",
					}),
				],
				["village", tileCell(6, 0, 6, 1)],
			]),
		);
		expect(layoutWrites(plan.mutations)).toHaveLength(0);
	});

	it("arranges in Results order, not array order", () => {
		expect(preset).toBeDefined();
		if (preset === undefined) return;
		const plan = planTilePreset({
			moduleUuid: MODULE,
			columns: [
				column("second", "Village", { listOrder: "b" }),
				column("first", "Patient name", { listOrder: "a" }),
			],
			preset,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(placements(plan.mutations).get("first")).toEqual(
			tileCell(0, 0, 6, 1),
		);
		expect(placements(plan.mutations).get("second")).toEqual(
			tileCell(6, 0, 6, 1),
		);
	});

	it("refuses a preset that has no room, naming it", () => {
		expect(preset).toBeDefined();
		if (preset === undefined) return;
		const plan = planTilePreset({
			moduleUuid: MODULE,
			columns: [column("only", "Patient name", { listOrder: "a" })],
			preset,
		});
		expect(plan.ok).toBe(false);
		expect(plan.ok === false && plan.reason).toBe(
			"Two columns has no room for 1 field.",
		);
	});
});

describe("planTilePlaceField", () => {
	it("drops the field into the first free space", () => {
		const plan = planTilePlaceField({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", {
					listOrder: "a",
					tile: tileCell(0, 0, 12, 1),
				}),
				column("village", "Village", { listOrder: "b" }),
			],
			uuid: asUuid("village"),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(placements(plan.mutations).get("village")).toEqual(
			tileCell(0, 1, 12, 1),
		);
	});

	it("refuses when the tile is full", () => {
		const plan = planTilePlaceField({
			moduleUuid: MODULE,
			columns: [
				column("name", "Patient name", {
					listOrder: "a",
					tile: tileCell(0, 0, 12, 12),
				}),
				column("village", "Village", { listOrder: "b" }),
			],
			uuid: asUuid("village"),
		});
		expect(plan.ok).toBe(false);
		expect(plan.ok === false && plan.reason).toBe(
			"There is no room left on the tile. Make another field smaller first.",
		);
	});
});

describe("tileCellMutations", () => {
	it("writes a placement as its own mergeable slot", () => {
		const source = column("name", "Patient name", { listOrder: "a" });
		const [mutation] = tileCellMutations(MODULE, source, tileCell(1, 2, 3, 4));
		expect(mutation).toMatchObject({
			kind: "updateColumn",
			moduleUuid: MODULE,
			uuid: source.uuid,
			tilePatch: tileCell(1, 2, 3, 4),
		});
	});

	it("clears a placement with an explicit null so the clear survives JSON", () => {
		const source = column("name", "Patient name", {
			listOrder: "a",
			tile: tileCell(0, 0, 6, 1),
		});
		const [mutation] = tileCellMutations(MODULE, source, undefined);
		expect(mutation).toMatchObject({ kind: "updateColumn", tilePatch: null });
	});

	it("plans nothing when the placement is unchanged", () => {
		const source = column("name", "Patient name", {
			listOrder: "a",
			tile: tileCell(0, 0, 6, 1),
		});
		expect(tileCellMutations(MODULE, source, tileCell(0, 0, 6, 1))).toEqual([]);
	});
});
