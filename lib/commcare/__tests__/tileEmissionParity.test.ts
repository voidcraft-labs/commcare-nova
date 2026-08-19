/**
 * The three emission paths agree about which columns hold a square.
 *
 * `lib/domain/modules.ts::tileCellFor` is the single admission decision,
 * but a shared helper only helps while every path actually calls it — the
 * bug this file exists to prevent was three paths each deciding
 * independently, two of them right and the HQ JSON writer wrong, so an
 * uploaded app drew a different tile from the one the author arranged and
 * the local `.ccz` produced.
 *
 * So this asserts the agreement itself, on ONE document, rather than
 * trusting three per-path tests that could each stay green while drifting
 * apart. The document deliberately carries the shape that broke: a column
 * hidden from Results that still owns a Default-order rule AND kept the
 * placement it had before it was hidden, with a border on that retained
 * cell so a leak would also flip the whole tile to boxed.
 */

import AdmZip from "adm-zip";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import type { BlueprintDoc } from "@/lib/domain";
import { orderedColumns, tileCell } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { splitTileGridByGroupHeader } from "@/lib/preview/caseTileGrouping";
import { projectTileGrid } from "@/lib/preview/caseTileLayout";
import { tileResultsColumns } from "@/lib/preview/caseTileRendering";

/** Shown, placed, and bordered. */
const SHOWN = tileCell(0, 0, 4, 1);
/**
 * Hidden from Results, still orders the list, still holds the placement it
 * had before it was hidden — reaching to column 10 and asking for a border,
 * so a leak on any path is visible twice over: a wider grid AND a tile
 * switched into boxed layout.
 */
const HIDDEN_CARRIER = tileCell(4, 0, 6, 2, { showBorder: true });

function tiledDoc(): BlueprintDoc {
	const base = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "village", header: "Village" },
	]);
	return buildDoc({
		appName: "TileEmissionParity",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...base,
					columns: [
						{ ...base.columns[0], tile: SHOWN },
						{
							...base.columns[1],
							tile: HIDDEN_CARRIER,
							visibleInList: false,
							sort: { direction: "asc" as const, priority: 0 },
						},
					],
					tile: {},
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "notes", label: proseText("Notes") }),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
		],
	});
}

/** Every `<grid>` under the short detail, as attribute maps. */
function suiteGrids(doc: BlueprintDoc): Record<string, string>[] {
	const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
	const entry = zip.getEntry("suite.xml");
	if (entry === null) throw new Error("compileCcz produced no suite.xml");

	const grids: Record<string, string>[] = [];
	let depth = 0;
	let inShortDetail = false;
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				if (name === "detail" && attribs.id === "m0_case_short") {
					inShortDetail = true;
					depth = 0;
				}
				if (inShortDetail) {
					depth += 1;
					if (name === "grid") grids.push({ ...attribs });
				}
			},
			onclosetag() {
				if (!inShortDetail) return;
				depth -= 1;
				if (depth === 0) inShortDetail = false;
			},
		},
		{ xmlMode: true },
	);
	parser.write(entry.getData().toString("utf-8"));
	parser.end();
	return grids;
}

/**
 * The same shape, GROUPED: a name band over a visit band, plus the same
 * hidden carrier — placed so that if any path counted it, the header band
 * would gain a cell that straddles the boundary.
 */
function groupedDoc(): BlueprintDoc {
	const base = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "village", header: "Village" },
		{ field: "last_visit", header: "Last visit" },
	]);
	return buildDoc({
		appName: "GroupedTileEmissionParity",
		modules: [
			{
				name: "Visits",
				caseType: "patient",
				caseListConfig: {
					...base,
					columns: [
						{ ...base.columns[0], tile: tileCell(0, 0, 4, 1) },
						{
							...base.columns[1],
							tile: HIDDEN_CARRIER,
							visibleInList: false,
							sort: { direction: "asc" as const, priority: 0 },
						},
						{ ...base.columns[2], tile: tileCell(0, 1, 4, 1) },
					],
					tile: { grouping: { identifier: "parent", headerRows: 1 } },
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "notes", label: proseText("Notes") }),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
					{ name: "last_visit", label: proseText("Last visit") },
				],
			},
		],
	});
}

/** Every `<group>` under the short detail, as attribute maps. */
function suiteGroups(doc: BlueprintDoc): Record<string, string>[] {
	const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
	const entry = zip.getEntry("suite.xml");
	if (entry === null) throw new Error("compileCcz produced no suite.xml");

	const groups: Record<string, string>[] = [];
	let depth = 0;
	let inShortDetail = false;
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				if (name === "detail" && attribs.id === "m0_case_short") {
					inShortDetail = true;
					depth = 0;
				}
				if (inShortDetail) {
					depth += 1;
					if (name === "group") groups.push({ ...attribs });
				}
			},
			onclosetag() {
				if (!inShortDetail) return;
				depth -= 1;
				if (depth === 0) inShortDetail = false;
			},
		},
		{ xmlMode: true },
	);
	parser.write(entry.getData().toString("utf-8"));
	parser.end();
	return groups;
}

describe("the three emission paths agree about which columns hold a square", () => {
	it("gives a square to the shown column and to nothing else", () => {
		const doc = tiledDoc();
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (config === undefined) throw new Error("expected a case-list config");

		// (1) The local `.ccz` suite: exactly one `<grid>`, the shown column's.
		const grids = suiteGrids(doc);
		expect(grids).toEqual([
			{
				"grid-height": "1",
				"grid-width": "4",
				"grid-x": "0",
				"grid-y": "0",
			},
		]);

		// (2) HQ JSON — the PRIMARY delivery path, and the one that was wrong.
		// The carrier is still persisted so CCHQ can sort by it, but carries
		// none of the four coordinates and none of the presentation slots.
		const { caseDetails } = projectCaseListForHq(module, doc);
		expect(caseDetails.short.columns).toHaveLength(2);
		expect(caseDetails.short.columns[0]).toMatchObject({
			grid_x: 0,
			grid_y: 0,
			width: 4,
			height: 1,
		});
		const carrier = caseDetails.short.columns[1];
		expect(carrier.grid_x).toBeNull();
		expect(carrier.grid_y).toBeNull();
		expect(carrier.width).toBeNull();
		expect(carrier.height).toBeNull();
		expect(carrier.show_border).toBeNull();

		// (3) The preview projection.
		const carried = tileResultsColumns(
			orderedColumns(config, "list"),
			config.tile,
		);
		const projection = projectTileGrid(carried.map((entry) => entry.column));
		expect(projection.cells).toHaveLength(1);
		expect(projection.cells[0].columnUuid).toBe(config.columns[0].uuid);

		// The agreement that matters: all three describe the SAME grid. The
		// carrier reaches to column 10 and asks for a border, so any path that
		// leaked it would report a 10-column extent here, or a boxed tile.
		expect(projection.columns).toBe(4);
		expect(projection.rows).toBe(1);
		expect(projection.cells[0].mode).toBe("flow");

		// And the carrier is still CARRIED on both wire paths — dropping it
		// would silently break ordering, which is the opposite failure.
		expect(carried).toHaveLength(2);
		expect(carried[1].valueHidden).toBe(true);
		expect(caseDetails.short.columns[1].format).toBe("invisible");
	});
});

describe("every surface agrees about a GROUPED tile, on one document", () => {
	it("splits the same tile the same way in the wire, the preview, and the read surface", () => {
		const doc = groupedDoc();
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (config === undefined) throw new Error("expected a case-list config");

		// (1) The local `.ccz` suite. HQ's own byte oracle for this element is
		// `commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles_grouping.py::SuiteCaseTilesGroupingTest`,
		// whose inline partial is exactly this attribute pair.
		expect(suiteGroups(doc)).toEqual([
			{ function: "string(./index/parent)", "header-rows": "1" },
		]);

		// (2) HQ JSON — the PRIMARY delivery path.
		const { caseDetails } = projectCaseListForHq(module, doc);
		expect(caseDetails.short.case_tile_group).toEqual({
			doc_type: "CaseTileGroupConfig",
			index_identifier: "parent",
			header_rows: 1,
		});
		expect(caseDetails.long.case_tile_group).toBeUndefined();

		// (3) The preview projection, split for the grouped renderer.
		const carried = tileResultsColumns(
			orderedColumns(config, "list"),
			config.tile,
		);
		const projection = projectTileGrid(carried.map((entry) => entry.column));
		const split = splitTileGridByGroupHeader(projection, 1);
		// The hidden carrier reaches row 0 and spans two rows, so any path that
		// counted it would put a boundary-crossing cell in the header. Exactly
		// one cell in each half, and the extent stays the shown columns'.
		expect(split.header.cells.map((cell) => cell.columnUuid)).toEqual([
			config.columns[0].uuid,
		]);
		expect(split.body.cells.map((cell) => cell.columnUuid)).toEqual([
			config.columns[2].uuid,
		]);
		expect(split.header.columns).toBe(4);
		expect(split.header.rows).toBe(2);

		// (4) The SA's read surface, which is the only read an edit turn gets.
		const summary = summarizeBlueprint(doc);
		expect(summary).toContain("grouped_by: parent connection");
		expect(summary).toContain("top row is the group heading");
	});
});
