/**
 * HQ-JSON projection of the case-list tile layout.
 *
 * These pin the persisted document CCHQ regenerates its suite from, which
 * is a different surface from the `.ccz` suite Nova emits directly — the
 * two must agree, so the parity assertions here mirror the wire-fixture
 * assertions in `lib/commcare/__tests__/compiler.test.ts`.
 *
 * The reference for the field names is
 * `commcare-hq/corehq/apps/app_manager/models/case_list.py::DetailColumn`,
 * whose custom-tile slots are `grid_x` / `grid_y` and the UNPREFIXED
 * `width` / `height` (the wire's `grid-width` / `grid-height` come from
 * the emitter's mapping, not the model), plus `horizontal_align`,
 * `vertical_align`, `font_size`, `show_border`, `show_shading`.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import type { BlueprintDoc, CaseTileLayout, TileCell } from "@/lib/domain";
import { tileCell } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function tiledDoc(
	tile: CaseTileLayout | undefined,
	cells: readonly (TileCell | undefined)[],
): BlueprintDoc {
	const base = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "town", header: "Town" },
	]);
	return buildDoc({
		appName: "T",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...base,
					columns: base.columns.map((column, index) => ({
						...column,
						...(cells[index] !== undefined && { tile: cells[index] }),
					})),
					...(tile !== undefined && { tile }),
				},
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
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
					{ name: "town", label: proseText("Town") },
				],
			},
		],
	});
}

function project(
	tile: CaseTileLayout | undefined,
	cells: readonly (TileCell | undefined)[],
) {
	const doc = tiledDoc(tile, cells);
	return projectCaseListForHq(doc.modules[doc.moduleOrder[0]], doc);
}

describe("case-tile HQ JSON projection", () => {
	it("writes the custom template and per-column placement on the short detail", () => {
		const { caseDetails } = project({}, [
			tileCell(0, 0, 12, 1, {
				horizontalAlign: "left",
				verticalAlign: "middle",
				fontSize: "medium",
			}),
			tileCell(0, 1, 6, 2, { showBorder: true, showShading: false }),
		]);

		// Nova never persists a named template — only CCHQ's `custom` arm,
		// where every column carries its own placement.
		expect(caseDetails.short.case_tile_template).toBe("custom");

		expect(caseDetails.short.columns[0]).toMatchObject({
			grid_x: 0,
			grid_y: 0,
			width: 12,
			height: 1,
			horizontal_align: "left",
			// Nova's authoring word `middle` becomes the value Web Apps honors.
			vertical_align: "center",
			font_size: "medium",
		});
		expect(caseDetails.short.columns[1]).toMatchObject({
			grid_x: 0,
			grid_y: 1,
			width: 6,
			height: 2,
			show_border: true,
			show_shading: false,
		});
		// An unset presentation slot stays null rather than taking a default:
		// an absent font size makes the cell inherit the list's size.
		expect(caseDetails.short.columns[1].font_size).toBeNull();
		expect(caseDetails.short.columns[1].horizontal_align).toBeNull();
	});

	it("leaves the long detail a plain field list", () => {
		const { caseDetails } = project({}, [
			tileCell(0, 0, 12, 1),
			tileCell(0, 1, 12, 1),
		]);
		expect(caseDetails.long.case_tile_template).toBeNull();
		for (const column of caseDetails.long.columns) {
			expect(column.grid_x).toBeNull();
			expect(column.grid_y).toBeNull();
			expect(column.width).toBeNull();
			expect(column.height).toBeNull();
		}
	});

	it("writes persist_tile_on_forms only when the tile asks to stay above forms", () => {
		const cells = [tileCell(0, 0, 12, 1), tileCell(0, 1, 12, 1)] as const;
		expect(
			project({}, cells).caseDetails.short.persist_tile_on_forms,
		).toBeNull();
		expect(
			project({ persistOnForms: true }, cells).caseDetails.short
				.persist_tile_on_forms,
		).toBe(true);
	});

	it("writes no tile at all when the case list has no layout", () => {
		// Cells persist while the layout is off, so switching back restores the
		// drawing — but nothing about them reaches the persisted document.
		const { caseDetails } = project(undefined, [
			tileCell(0, 0, 12, 1),
			tileCell(0, 1, 12, 1),
		]);
		expect(caseDetails.short.case_tile_template).toBeNull();
		for (const column of caseDetails.short.columns) {
			expect(column.grid_x).toBeNull();
			expect(column.width).toBeNull();
		}
	});

	it("writes no placement for a hidden column that kept its cell", () => {
		// The third consumer of the visible-only emission invariant. A column
		// hidden from Results that still owns a Default-order rule stays in the
		// persisted detail — CCHQ needs the field to sort by it — but its
		// placement must NOT ride along: CCHQ's own regeneration would build a
		// `<style><grid>` from any non-null coordinate, and
		// `Detail.java::getMaxWidthHeight` sums every field's extent, so an
		// invisible column would widen the uploaded tile past the local `.ccz`.
		const doc = tiledDoc({}, [tileCell(0, 0, 6, 1), tileCell(6, 0, 6, 1)]);
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (config === undefined) throw new Error("expected a case-list config");
		config.columns[1] = {
			...config.columns[1],
			visibleInList: false,
			sort: { direction: "asc", priority: 0 },
		};
		const { caseDetails } = projectCaseListForHq(module, doc);

		// The carrier is still persisted, so the sort survives.
		expect(caseDetails.short.columns).toHaveLength(2);
		// The visible column keeps its placement.
		expect(caseDetails.short.columns[0].grid_x).toBe(0);
		// The hidden carrier carries none of the four.
		const carrier = caseDetails.short.columns[1];
		expect(carrier.grid_x).toBeNull();
		expect(carrier.grid_y).toBeNull();
		expect(carrier.width).toBeNull();
		expect(carrier.height).toBeNull();
	});

	it("keeps an unplaced column's grid slots null", () => {
		const { caseDetails } = project({}, [tileCell(0, 0, 12, 1), undefined]);
		expect(caseDetails.short.columns[0].grid_x).toBe(0);
		// A partial grid is what makes CCHQ emit a `<grid>` the device cannot
		// parse, so an unplaced column carries none of the four rather than some.
		expect(caseDetails.short.columns[1].grid_x).toBeNull();
		expect(caseDetails.short.columns[1].grid_y).toBeNull();
		expect(caseDetails.short.columns[1].width).toBeNull();
		expect(caseDetails.short.columns[1].height).toBeNull();
	});
});
