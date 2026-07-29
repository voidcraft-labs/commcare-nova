/**
 * Behavioral tests for `setCaseListTile`.
 *
 * Drives the tool through `GenerationContext`, so every call runs the real
 * commit gate. Coverage splits three ways:
 *
 *   1. Input → mutations. A placement becomes one granular `updateColumn`
 *      carrying `tilePatch`, the layout becomes one `setCaseListMeta` carrying
 *      the top-level `tilePatch`, and each CLEAR travels as an explicit `null`
 *      (the wire spelling — `JSON.stringify` drops `undefined`).
 *   2. The null-clears contract in both directions: `tile: null` turns the tile
 *      off while KEEPING every placement, `cell: null` takes one field off the
 *      tile, and an omitted slot changes nothing.
 *   3. Why the layout and the placements share one tool: the gate rejects
 *      turning the tile on with a field left unplaced, and rejects half of a
 *      swap — both of which are only reachable if the two were separate calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type Column,
	type Module,
	plainColumn,
	tileCell,
	type Uuid,
} from "@/lib/domain";
import { setCaseListTileTool } from "../setCaseListTile";
import { MOD_A, makeCaseListFixture, makeCaseListMcpFixture } from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

const NAME_COLUMN = testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
const STATUS_COLUMN = testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

/** A doc whose module carries a two-field case list, laid out as rows. */
function docWithColumns(columns: Column[]): {
	doc: BlueprintDoc;
	ctx: ReturnType<typeof makeCaseListFixture>["ctx"];
} {
	const { doc: baseDoc, ctx } = makeCaseListFixture();
	const doc: BlueprintDoc = {
		...baseDoc,
		modules: {
			[MOD_A]: {
				...baseDoc.modules[MOD_A],
				caseListConfig: resolveCaseListConfig({ columns, searchInputs: [] }),
			} as Module,
		},
	};
	return { doc, ctx };
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

function expectSuccess(result: { error: string } | { layout: string }) {
	if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
	return result;
}

describe("setCaseListTile", () => {
	it("turns the tile on and places every field in one call", async () => {
		const { doc, ctx } = docWithColumns(unplacedColumns());

		const result = await setCaseListTileTool.execute(
			{
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
			},
			ctx,
			doc,
		);

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({ layout: "tile", unplacedColumnUuids: [] });
		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.tile).toEqual({});
		expect(columnTile(result.newDoc, NAME_COLUMN)).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
		});
		expect(columnTile(result.newDoc, STATUS_COLUMN)).toEqual({
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
		const { doc, ctx } = docWithColumns(unplacedColumns());

		const result = await setCaseListTileTool.execute(
			{
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
			},
			ctx,
			doc,
		);

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
		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.tile).toEqual({
			persistOnForms: true,
		});
	});

	it("carries the presentation slots on the cell they belong to", async () => {
		const { doc, ctx } = docWithColumns(unplacedColumns());

		const result = await setCaseListTileTool.execute(
			{
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
			},
			ctx,
			doc,
		);

		expectSuccess(result.result);
		expect(columnTile(result.newDoc, NAME_COLUMN)).toEqual({
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
		const { doc: baseDoc, ctx } = docWithColumns(placedColumns());
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
				} as Module,
			},
		};

		const result = await setCaseListTileTool.execute(
			{ moduleUuid: MOD_A, tile: null },
			ctx,
			doc,
		);

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({ layout: "rows", unplacedColumnUuids: [] });
		const config = result.newDoc.modules[MOD_A]?.caseListConfig;
		expect(config && "tile" in config).toBe(false);
		expect(columnTile(result.newDoc, NAME_COLUMN)).toBeDefined();
		expect(columnTile(result.newDoc, STATUS_COLUMN)).toBeDefined();
		expect(result.mutations).toEqual([
			{ kind: "setCaseListMeta", uuid: MOD_A, patch: { tile: null } },
		]);
	});

	it("takes one field off the tile with an explicit null cell", async () => {
		// The clear must reach the client doc store and Postgres: `JSON.stringify`
		// drops an `undefined`-valued key, so the wire spelling has to be `null`.
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				placements: [{ columnUuid: STATUS_COLUMN, cell: null }],
			},
			ctx,
			doc,
		);

		expectSuccess(result.result);
		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "updateColumn",
				uuid: STATUS_COLUMN,
				tilePatch: null,
			}),
		]);
		expect(columnTile(result.newDoc, STATUS_COLUMN)).toBeUndefined();
		expect(columnTile(result.newDoc, NAME_COLUMN)).toBeDefined();
	});

	it("leaves the layout alone when `tile` is omitted", async () => {
		const { doc: baseDoc, ctx } = docWithColumns(placedColumns());
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
				} as Module,
			},
		};

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				placements: [
					{
						columnUuid: STATUS_COLUMN,
						cell: { x: 6, y: 1, width: 6, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({ layout: "tile" });
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual([
			"updateColumn",
		]);
		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.tile).toEqual({
			persistOnForms: true,
		});
	});

	it("leaves an unnamed field's placement untouched", async () => {
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				placements: [
					{
						columnUuid: STATUS_COLUMN,
						cell: { x: 6, y: 1, width: 6, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		expectSuccess(result.result);
		expect(columnTile(result.newDoc, NAME_COLUMN)).toEqual(
			tileCell(0, 0, 12, 1, { fontSize: "large" }),
		);
	});

	it("emits nothing when the layout and every named cell already match", async () => {
		const { doc: baseDoc, ctx } = docWithColumns(placedColumns());
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
				} as Module,
			},
		};

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				tile: {},
				placements: [
					{
						columnUuid: STATUS_COLUMN,
						cell: { x: 0, y: 1, width: 6, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		expectSuccess(result.result);
		expect(result.mutations).toEqual([]);
	});

	it("swaps two fields in one call", async () => {
		// The reason placement lives with the layout: either half of this swap on
		// its own puts two fields on the same square, which the gate rejects.
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{
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
			},
			ctx,
			doc,
		);

		expectSuccess(result.result);
		expect(columnTile(result.newDoc, NAME_COLUMN)).toEqual({
			x: 0,
			y: 1,
			width: 6,
			height: 1,
		});
		expect(columnTile(result.newDoc, STATUS_COLUMN)).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
		});
	});

	it("is rejected when half a swap would put two fields on one square", async () => {
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				placements: [
					{
						columnUuid: NAME_COLUMN,
						cell: { x: 0, y: 1, width: 6, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("on top of each other");
		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.columns).toEqual(
			placedColumns(),
		);
	});

	it("is rejected when the tile is turned on with a field left unplaced", async () => {
		const { doc, ctx } = docWithColumns(unplacedColumns());

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				tile: {},
				placements: [
					{
						columnUuid: NAME_COLUMN,
						cell: { x: 0, y: 0, width: 12, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("no place on the tile");
		expect(result.newDoc.modules[MOD_A]?.caseListConfig?.tile).toBeUndefined();
	});

	it("names the fields still needing a place while the list is on rows", async () => {
		const { doc, ctx } = docWithColumns(unplacedColumns());

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				placements: [
					{
						columnUuid: NAME_COLUMN,
						cell: { x: 0, y: 0, width: 12, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		const success = expectSuccess(result.result);
		expect(success).toMatchObject({
			layout: "rows",
			unplacedColumnUuids: [STATUS_COLUMN],
		});
	});

	it("rejects a field named twice in one call", async () => {
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{
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
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("twice in one call");
	});

	it("rejects a placement naming an unknown field", async () => {
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{
				moduleUuid: MOD_A,
				placements: [
					{
						columnUuid: testUuid("unknown-column"),
						cell: { x: 0, y: 0, width: 6, height: 1 },
					},
				],
			},
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("Found no field with that uuid");
	});

	it("rejects a call that names neither the layout nor a placement", async () => {
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{ moduleUuid: MOD_A },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("neither `tile` nor `placements`");
	});

	it("rejects a module that has no case list at all", async () => {
		// The metadata reducer edits an EXISTING config and never births one, so a
		// silent success here would claim a layout that was never stored.
		const { doc, ctx } = makeCaseListFixture();

		const result = await setCaseListTileTool.execute(
			{ moduleUuid: MOD_A, tile: {} },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("has no case list");
		expect(result.newDoc.modules[MOD_A]?.caseListConfig).toBeUndefined();
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const { doc, ctx } = docWithColumns(placedColumns());

		const result = await setCaseListTileTool.execute(
			{ moduleUuid: testUuid("unknown-module"), tile: {} },
			ctx,
			doc,
		);

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) throw new Error("expected error result");
		expect(result.result.error).toContain("No module with UUID");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = docWithColumns(placedColumns());
		const { ctx: mcpCtx } = makeCaseListMcpFixture();
		const input = {
			moduleUuid: MOD_A,
			tile: { persistOnForms: true } as const,
			placements: [
				{
					columnUuid: STATUS_COLUMN,
					cell: { x: 6, y: 1, width: 6, height: 1 },
				},
			],
		};

		const r1 = await setCaseListTileTool.execute(input, chatCtx, doc);
		const r2 = await setCaseListTileTool.execute(input, mcpCtx, doc);

		expect(r1.mutations).toEqual(r2.mutations);
	});
});
