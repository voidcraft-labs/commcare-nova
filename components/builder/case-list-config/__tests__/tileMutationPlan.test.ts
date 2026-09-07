import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type Column,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	planTileGrouping,
	planTileLayoutDisable,
	planTileLayoutEnable,
	planTilePersistOnForms,
	planTilePlaceField,
	planTilePreset,
	type TilePlanOutcome,
	tileCellMutations,
} from "../tile/tileMutationPlan";
import { TILE_PRESETS } from "../tile/tilePresets";
import { admittedWorkspace, commitWorkspace } from "./admittedWorkspace";

function column(id: string, slots: Parameters<typeof plainColumn>[3] = {}) {
	return plainColumn(testUuid(id), id, id, slots);
}
function workspace(columns: Column[], tile?: CaseListConfig["tile"]) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = columns;
	config.listColumnOrder = columns.map((c) => c.uuid);
	config.detailColumnOrder = columns.map((c) => c.uuid);
	if (tile) config.tile = tile;
	const fixture = admittedWorkspace(
		[
			{
				name: "patient",
				properties: columns.map((c) => ({
					name: c.kind === "calculated" ? "case_name" : c.field,
					label: proseText(c.header),
					data_type: "text",
				})),
			},
		],
		config,
	);
	let doc = fixture.doc;
	return {
		moduleUuid: fixture.moduleUuid,
		get config() {
			const saved = doc.modules[fixture.moduleUuid].caseListConfig;
			if (!saved) throw new Error("missing config");
			return saved;
		},
		commit(mutations: readonly Mutation[]) {
			doc = commitWorkspace(doc, mutations);
		},
		apply(plan: TilePlanOutcome) {
			expect(plan).toMatchObject({ ok: true });
			if (!plan.ok) throw new Error(plan.reason);
			doc = commitWorkspace(doc, plan.mutations);
		},
	};
}

describe("tile plans commit real document transitions", () => {
	it("enables, disables and restores placements while preserving hidden and Details-only information", () => {
		const original = [
			column("case_name"),
			column("village"),
			column("sorter", {
				visibleInList: false,
				sort: { direction: "asc", priority: 0 },
			}),
			column("notes", { visibleInList: false }),
		];
		const w = workspace(original);
		w.apply(planTileLayoutEnable(w));
		expect(w.config.tile).toEqual({});
		expect(w.config.columns.map((c) => c.tile)).toEqual([
			tileCell(0, 0, 12, 1),
			tileCell(0, 1, 12, 1),
			undefined,
			undefined,
		]);
		const drawn = structuredClone(w.config.columns);
		w.commit(planTileLayoutDisable(w.moduleUuid));
		expect(w.config.tile).toBeUndefined();
		expect(w.config.columns).toEqual(drawn);
		w.apply(planTileLayoutEnable(w));
		expect(w.config.columns).toEqual(drawn);
		expect(w.config.tile).toEqual({});
	});
	it("keeps authored geometry and presentation while placing only missing members", () => {
		const first = column("case_name", {
			tile: tileCell(0, 3, 6, 2, { fontSize: "large", showBorder: true }),
		});
		const w = workspace([first, column("village")]);
		w.apply(planTileLayoutEnable(w));
		expect(w.config.columns[0]).toEqual(first);
		expect(w.config.columns[1].tile).toEqual(tileCell(0, 0, 12, 1));
	});
	it("refuses a reachable rows layout with more members than a tile can hold without a partial edit", () => {
		const w = workspace(
			Array.from({ length: 145 }, (_, i) => column(`field_${i}`)),
		);
		const before = structuredClone(w.config);
		expect(planTileLayoutEnable(w)).toEqual({
			ok: false,
			reason:
				"A tile has room for 144 fields, and Results shows 145. Hide some information from Results first.",
		});
		expect(w.config).toEqual(before);
	});
	it("refuses when the retained drawing fills the grid and names the unplaced member", () => {
		const w = workspace([
			column("case_name", { tile: tileCell(0, 0, 12, 12) }),
			column("village"),
		]);
		expect(planTileLayoutEnable(w)).toEqual({
			ok: false,
			reason:
				"There is no room left on the tile for village. Make another field smaller, or hide this one from Results.",
		});
	});
	it("keeps grouping and form persistence through independent toggles", () => {
		const w = workspace(
			[
				column("case_name", { tile: tileCell(0, 0, 12, 1) }),
				column("village", { tile: tileCell(0, 1, 12, 1) }),
			],
			{},
		);
		w.commit(
			planTileGrouping(
				w.moduleUuid,
				{ identifier: "parent", headerRows: 1 },
				w.config.tile,
			),
		);
		w.commit(planTilePersistOnForms(w.moduleUuid, true, w.config.tile));
		expect(w.config.tile).toEqual({
			grouping: { identifier: "parent", headerRows: 1 },
			persistOnForms: true,
		});
		w.commit(planTilePersistOnForms(w.moduleUuid, false, w.config.tile));
		expect(w.config.tile).toEqual({
			grouping: { identifier: "parent", headerRows: 1 },
		});
		w.commit(planTilePersistOnForms(w.moduleUuid, true, w.config.tile));
		w.commit(planTileGrouping(w.moduleUuid, undefined, w.config.tile));
		expect(w.config.tile).toEqual({ persistOnForms: true });
	});
	it("applies a preset in Results order and preserves all presentation and Details ordering", () => {
		const first = column("first", {
				tile: tileCell(0, 4, 3, 1, {
					fontSize: "large",
					horizontalAlign: "center",
					showBorder: true,
				}),
			}),
			second = column("second");
		const w = workspace([second, first]);
		w.commit([
			{
				kind: "moveColumn",
				moduleUuid: w.moduleUuid,
				uuid: first.uuid,
				surface: "list",
				after: null,
			},
		]);
		const before = structuredClone(w.config);
		const preset = TILE_PRESETS.find((p) => p.id === "two-columns");
		if (!preset) throw new Error("missing preset");
		w.apply(planTilePreset({ ...w, preset }));
		expect(w.config.columns.find((c) => c.uuid === first.uuid)).toEqual({
			...first,
			tile: tileCell(0, 0, 6, 1, {
				fontSize: "large",
				horizontalAlign: "center",
				showBorder: true,
			}),
		});
		expect(w.config.columns.find((c) => c.uuid === second.uuid)?.tile).toEqual(
			tileCell(6, 0, 6, 1),
		);
		expect(w.config.detailColumnOrder).toEqual(before.detailColumnOrder);
		expect(w.config.listColumnOrder).toEqual([first.uuid, second.uuid]);
		expect(w.config.tile).toBeUndefined();
	});
	it("refuses an unavailable preset without proposing an invalid mutation batch", () => {
		const w = workspace([column("case_name")]);
		const preset = TILE_PRESETS.find((p) => p.id === "two-columns");
		if (!preset) throw new Error("missing preset");
		expect(planTilePreset({ ...w, preset })).toEqual({
			ok: false,
			reason: "Two columns has no room for 1 field.",
		});
	});
	it("places one field then clears it through the JSON mutation protocol without changing its other slots", () => {
		const target = column("village", {
			sort: { direction: "desc", priority: 0 },
			visibleInDetail: false,
		});
		const w = workspace([
			column("case_name", { tile: tileCell(0, 0, 12, 1) }),
			target,
		]);
		w.apply(planTilePlaceField({ ...w, uuid: target.uuid }));
		expect(w.config.columns[1]).toEqual({
			...target,
			tile: tileCell(0, 1, 12, 1),
		});
		w.commit(tileCellMutations(w.moduleUuid, w.config.columns[1], undefined));
		expect(w.config.columns[1]).toEqual(target);
		expect(tileCellMutations(w.moduleUuid, target, undefined)).toEqual([]);
	});
	it("refuses a full grid and a stale removed field at the planner boundary", () => {
		const w = workspace([
			column("case_name", { tile: tileCell(0, 0, 12, 12) }),
			column("village"),
		]);
		expect(planTilePlaceField({ ...w, uuid: testUuid("village") })).toEqual({
			ok: false,
			reason:
				"There is no room left on the tile. Make another field smaller first.",
		});
		expect(planTilePlaceField({ ...w, uuid: testUuid("removed") })).toEqual({
			ok: false,
			reason:
				"That field is no longer in this case list. Reopen Results to see what it shows now.",
		});
	});
});
