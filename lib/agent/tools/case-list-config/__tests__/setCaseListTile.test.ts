/** Admitted domain commands through the actual workspace and reducer over
 * controlled host receipts. No browser layout or SQL transaction claim. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type Column,
	plainColumn,
	tileCell,
	type Uuid,
} from "@/lib/domain";
import { setCaseListTileTool } from "../setCaseListTile";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

const NAME_COLUMN = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const STATUS_COLUMN = testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

/** A doc whose module carries a two-field case list, laid out as rows. */
function docWithColumns(columns: Column[]): BlueprintDoc {
	const baseDoc = makeCaseListDoc();
	return {
		...baseDoc,
		modules: {
			[MOD_A]: {
				...baseDoc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({ columns, searchInputs: [] }),
			},
		},
	};
}

/** The workspace every test drives, booted on that rows-layout doc. */
function fixtureWithColumns(columns: Column[]) {
	return makeCaseListFixture(docWithColumns(columns));
}

/** The rows-layout starting point every "turn it on" test builds from. */
function unplacedColumns(): Column[] {
	return [
		plainColumn(NAME_COLUMN, "case_name", "Patient"),
		plainColumn(STATUS_COLUMN, "status", "Status"),
	];
}

/** The same two fields already placed — a live tile to edit. */
function placedColumns(): Column[] {
	return [
		plainColumn(NAME_COLUMN, "case_name", "Patient", {
			tile: tileCell(0, 0, 12, 1, { fontSize: "large" }),
		}),
		plainColumn(STATUS_COLUMN, "status", "Status", {
			tile: tileCell(0, 1, 6, 1),
		}),
	];
}

function columnTile(doc: BlueprintDoc, uuid: Uuid) {
	return doc.modules[MOD_A]?.caseListConfig?.columns.find(
		(column) => column.uuid === uuid,
	)?.tile;
}

function expectSuccess(
	result: { error: string } | { layout: string; message?: string },
) {
	if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
	return result;
}

describe("setCaseListTile", () => {
	it("groups and places the tile in one host call", async () => {
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: { grouping: { identifier: "parent", headerRows: 1 } },
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 1, width: 12, height: 1 },
				},
			],
		});

		const success = expectSuccess(result.result);
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toEqual({
			grouping: { identifier: "parent", headerRows: 1 },
		});

		expect(success.layout).toBe("tile");
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("refuses a heading that leaves nothing per case, without touching the doc", async () => {
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: { grouping: { identifier: "parent", headerRows: 2 } },
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 1, width: 12, height: 1 },
				},
			],
		});

		if (!("error" in result.result)) {
			throw new Error("expected the gate to refuse a whole-tile heading");
		}
		expect(result.result.error).toContain("group header");
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toBeUndefined();
	});

	it("drops grouping with the tile, so no grouping survives a rows layout", async () => {
		const h = makeCaseListFixture({
			...docWithColumns([
				plainColumn(NAME_COLUMN, "case_name", "Patient", {
					tile: tileCell(0, 0, 12, 1),
				}),
				plainColumn(STATUS_COLUMN, "status", "Status", {
					tile: tileCell(0, 1, 12, 1),
				}),
			]),
		});
		expectSuccess(
			(
				await h.runTool(setCaseListTileTool, {
					moduleUuid: MOD_A,
					tile: { grouping: { identifier: "parent", headerRows: 1 } },
				})
			).result,
		);

		const off = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: null,
		});
		expect(expectSuccess(off.result)).toMatchObject({ layout: "rows" });
		// Grouping lives INSIDE the layout, so it leaves with it. Every cell
		// still survives, which is the whole point of the null-clear.
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toBeUndefined();
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
		});
	});

	it("turns the tile on and places every field in one call", async () => {
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: {},
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
			],
		});

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({ layout: "tile", unplacedColumnUuids: [] });
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toEqual({});
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
		});
		expect(columnTile(h.currentDoc(), STATUS_COLUMN)).toEqual({
			x: 0,
			y: 1,
			width: 6,
			height: 1,
		});
	});

	it("plans placements as granular per-column tilePatch writes, then the layout", async () => {
		// Placement is its own mergeable write: a peer relabelling the same field
		// is an edit to a different thing and must survive. The layout rides the
		// granular case-list metadata kind for the same reason.
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: { persistOnForms: true },
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
			],
		});

		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "updateColumn",
				uuid: NAME_COLUMN,
				tilePatch: { x: 0, y: 0, width: 12, height: 1 },
			}),
			expect.objectContaining({
				kind: "updateColumn",
				uuid: STATUS_COLUMN,
				tilePatch: { x: 0, y: 1, width: 6, height: 1 },
			}),
			{
				kind: "setCaseListMeta",
				uuid: MOD_A,
				patch: { tile: { persistOnForms: true } },
			},
		]);
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toEqual({
			persistOnForms: true,
		});
	});

	it("carries the presentation slots on the cell they belong to", async () => {
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: {},
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: {
						x: 0,
						y: 0,
						width: 12,
						height: 1,
						horizontalAlign: "center",
						verticalAlign: "middle",
						fontSize: "large",
						showBorder: true,
						showShading: true,
					},
				},
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
			],
		});

		expectSuccess(result.result);
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
			horizontalAlign: "center",
			verticalAlign: "middle",
			fontSize: "large",
			showBorder: true,
			showShading: true,
		});
	});

	it("turns the tile off with null and keeps every placement", async () => {
		// An author who tries a tile and goes back to columns must not lose the
		// layout they drew — turning it back on has to be accepted with no rework.
		const baseDoc = docWithColumns(placedColumns());
		const doc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						...baseDoc.modules[MOD_A].caseListConfig,
						columns: placedColumns(),
						searchInputs: [],
						tile: {},
					}),
				},
			},
		};

		const h = makeCaseListFixture(doc);
		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: null,
		});

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({ layout: "rows", unplacedColumnUuids: [] });
		const config = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(config && "tile" in config).toBe(false);
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toBeDefined();
		expect(columnTile(h.currentDoc(), STATUS_COLUMN)).toBeDefined();
		expect(result.mutations).toEqual([
			{ kind: "setCaseListMeta", uuid: MOD_A, patch: { tile: null } },
		]);
		expectSuccess(
			(await h.runTool(setCaseListTileTool, { moduleUuid: MOD_A, tile: {} }))
				.result,
		);
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig).toEqual(
			doc.modules[MOD_A]?.caseListConfig,
		);
	});

	it("takes one field off the tile with an explicit null cell", async () => {
		// The clear must reach the client doc store and Postgres: `JSON.stringify`
		// drops an `undefined`-valued key, so the wire spelling has to be `null`.
		const h = fixtureWithColumns(placedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [{ columnUuid: STATUS_COLUMN, cell: null }],
		});

		expectSuccess(result.result);
		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "updateColumn",
				uuid: STATUS_COLUMN,
				tilePatch: null,
			}),
		]);
		expect(columnTile(h.currentDoc(), STATUS_COLUMN)).toBeUndefined();
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toBeDefined();
	});

	it("leaves the layout alone when `tile` is omitted", async () => {
		const baseDoc = docWithColumns(placedColumns());
		const doc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: placedColumns(),
						searchInputs: [],
						tile: { persistOnForms: true },
					}),
				},
			},
		};

		const h = makeCaseListFixture(doc);
		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 6, y: 1, width: 6, height: 1 },
				},
			],
		});

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({ layout: "tile" });
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"updateColumn",
		]);
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toEqual({
			persistOnForms: true,
		});
	});

	it("leaves an unnamed field's placement untouched", async () => {
		const h = fixtureWithColumns(placedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 6, y: 1, width: 6, height: 1 },
				},
			],
		});

		expectSuccess(result.result);
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toEqual(
			tileCell(0, 0, 12, 1, { fontSize: "large" }),
		);
	});

	it("emits nothing when the layout and every named cell already match", async () => {
		const baseDoc = docWithColumns(placedColumns());
		const doc: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: placedColumns(),
						searchInputs: [],
						tile: {},
					}),
				},
			},
		};

		const h = makeCaseListFixture(doc);
		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: {},
			placements: [
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
			],
		});

		expectSuccess(result.result);
		expect(result.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("swaps two fields in one call", async () => {
		// The reason placement lives with the layout: either half of this swap on
		// its own puts two fields on the same square, which the gate rejects.
		const doc = docWithColumns(placedColumns());
		const config = doc.modules[MOD_A]?.caseListConfig;
		if (!config) throw new Error("Missing config");
		config.tile = {};
		const h = makeCaseListFixture(doc);

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
			],
		});

		expectSuccess(result.result);
		expect(columnTile(h.currentDoc(), NAME_COLUMN)).toEqual({
			x: 0,
			y: 1,
			width: 6,
			height: 1,
		});
		expect(columnTile(h.currentDoc(), STATUS_COLUMN)).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
		});
	});

	it("is rejected when half a swap would put two fields on one square", async () => {
		const doc = docWithColumns(placedColumns());
		const config = doc.modules[MOD_A]?.caseListConfig;
		if (!config) throw new Error("Missing config");
		config.tile = {};
		const h = makeCaseListFixture(doc);

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
			],
		});

		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("on top of each other");
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.columns).toEqual(
			placedColumns(),
		);
	});

	it("is rejected when the tile is turned on with a field left unplaced", async () => {
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			tile: {},
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
			],
		});

		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("no place on the tile");
		expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.tile).toBeUndefined();
	});

	it("names the fields still needing a place while the list is on rows", async () => {
		const h = fixtureWithColumns(unplacedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
			],
		});

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({
			layout: "rows",
			unplacedColumnUuids: [STATUS_COLUMN],
		});
	});

	it("rejects a field named twice in one call", async () => {
		const h = fixtureWithColumns(placedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 0, y: 0, width: 6, height: 1 },
				},
				{
					columnUuid: NAME_COLUMN,
					cell: { x: 6, y: 0, width: 6, height: 1 },
				},
			],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("twice in one call");
	});

	it("rejects a placement naming an unknown field", async () => {
		const h = fixtureWithColumns(placedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: MOD_A,
			placements: [
				{
					columnUuid: testUuid("unknown-column"),
					cell: { x: 0, y: 0, width: 6, height: 1 },
				},
			],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("Found no field with that uuid");
	});

	it("rejects a call that names neither the layout nor a placement", async () => {
		const h = fixtureWithColumns(placedColumns());

		const result = await h.runTool(setCaseListTileTool, { moduleUuid: MOD_A });

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("neither `tile` nor `placements`");
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = fixtureWithColumns(placedColumns());

		const result = await h.runTool(setCaseListTileTool, {
			moduleUuid: testUuid("unknown-module"),
			tile: {},
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("No module with UUID");
	});
});
