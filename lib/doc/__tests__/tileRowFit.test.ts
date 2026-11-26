/**
 * A tile has a row for each field it shows, at least six: the rows CommCare
 * HQ's own Case List and Case Detail pages keep (proof 4 over
 * `targeted-tile-row-bound`). A field leaving a screen takes a row with it,
 * so the edit that removes or hides it fits a cell below the new bottom back
 * in the same batch, through the production gate, on every editor's path
 * (`withDetailFieldLayout`, which the SA's, MCP's and the Builder's column
 * edits all go through).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	removeColumnMutation,
	updateColumnMutation,
} from "@/lib/agent/blueprintHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	plainColumn,
	tileCell,
	tileCellBottomEdge,
	tileCellsOverlap,
} from "@/lib/domain";

const PROPERTIES = Array.from({ length: 8 }, (_unused, i) =>
	i === 0 ? "case_name" : `part_${i}`,
);

/** A menu over `visit` whose eight fields each hold a full line, the last
 *  ending on the eighth row: the bottom of a tile of eight fields. */
function eightLines(where: "list" | "details"): BlueprintDoc {
	const columns: Column[] = PROPERTIES.map((property, row) =>
		plainColumn(
			testUuid(`line-${row}`),
			property,
			property,
			where === "list" ? { tile: tileCell(0, row, 12, 1) } : {},
		),
	);
	const order = columns.map((column) => column.uuid);
	const config: CaseListConfig = {
		columns,
		listColumnOrder: order,
		detailColumnOrder: [...order],
		searchInputs: [],
		...(where === "list"
			? { tile: {} }
			: {
					detailTile: {
						cells: Object.fromEntries(
							columns.map((column, row) => [
								column.uuid,
								tileCell(0, row, 12, 1),
							]),
						),
					},
				}),
	};
	return buildDoc({
		appName: "Tile rows",
		caseTypes: [
			{
				name: "visit",
				properties: PROPERTIES.map((name) => ({
					name,
					label: name,
					data_type: "text" as const,
				})),
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: config,
				forms: [
					{
						name: "Record visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes", label: "Notes" })],
					},
				],
			},
		],
	});
}

function menu(doc: BlueprintDoc) {
	const mod = doc.modules[doc.moduleOrder[0]];
	if (!mod?.caseListConfig) throw new Error("The menu has a case list.");
	return { mod, config: mod.caseListConfig };
}

function commit(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	return mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE);
}

function mutationsOf(
	result: ReturnType<typeof removeColumnMutation>,
): readonly Mutation[] {
	if ("error" in result) throw new Error(result.error);
	return result.mutations;
}

describe("a Results tile losing a field", () => {
	it("is refused without the fit: the eighth row is past a tile of seven fields", () => {
		const doc = eightLines("list");
		const { mod } = menu(doc);
		const verdict = commit(doc, [
			{
				kind: "removeColumn",
				moduleUuid: mod.uuid,
				uuid: testUuid("line-3"),
			},
		]);
		expect(verdict.ok).toBe(false);
		expect(
			verdict.ok ? [] : verdict.findings.map((finding) => finding.code),
		).toEqual(["CASE_LIST_TILE_CELL_OUT_OF_GRID"]);
	});

	it("fits the last line back in the batch that removes a field", () => {
		const doc = eightLines("list");
		const { mod } = menu(doc);
		const verdict = commit(
			doc,
			mutationsOf(removeColumnMutation(mod, testUuid("line-3"))),
		);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		const after = menu(verdict.nextDoc).config;
		const cells = after.columns.flatMap((column) =>
			column.tile ? [column.tile] : [],
		);
		expect(Math.max(...cells.map(tileCellBottomEdge))).toBe(7);
		// The freed fourth line takes the last field, which keeps its width.
		expect(
			after.columns.find((column) => column.uuid === testUuid("line-7"))?.tile,
		).toEqual(tileCell(0, 3, 12, 1));
		for (const [i, a] of cells.entries())
			for (const b of cells.slice(i + 1))
				expect(tileCellsOverlap(a, b)).toBe(false);
	});

	it("fits it back when a field is hidden from Results, and keeps the hidden field's saved place", () => {
		const doc = eightLines("list");
		const { mod, config } = menu(doc);
		const hidden = config.columns[2];
		const verdict = commit(
			doc,
			mutationsOf(
				updateColumnMutation(mod, hidden.uuid, {
					...hidden,
					visibleInList: false,
				}),
			),
		);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		const after = menu(verdict.nextDoc).config;
		expect(
			after.columns.find((column) => column.uuid === hidden.uuid)?.tile,
		).toEqual(tileCell(0, 2, 12, 1));
		// Seven lines fill a tile of seven fields: the last takes the square the
		// hidden field left, the only free one.
		expect(
			after.columns.find((column) => column.uuid === testUuid("line-7"))?.tile,
		).toEqual(tileCell(0, 2, 12, 1));
	});

	it("moves nothing while the tile keeps its rows", () => {
		const doc = eightLines("list");
		const { mod } = menu(doc);
		const removal = mutationsOf(removeColumnMutation(mod, testUuid("line-7")));
		expect(removal).toEqual([
			{ kind: "removeColumn", moduleUuid: mod.uuid, uuid: testUuid("line-7") },
		]);
	});
});

describe("a Details tile losing a field", () => {
	it("fits the last line back in the batch that removes a field", () => {
		const doc = eightLines("details");
		const { mod } = menu(doc);
		const verdict = commit(
			doc,
			mutationsOf(removeColumnMutation(mod, testUuid("line-0"))),
		);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		const cells = Object.values(
			menu(verdict.nextDoc).config.detailTile?.cells ?? {},
		);
		expect(cells).toHaveLength(7);
		expect(Math.max(...cells.map(tileCellBottomEdge))).toBe(7);
	});
});
