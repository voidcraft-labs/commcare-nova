import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, orderedColumns } from "@/lib/domain";
import { splitTileGridByGroupHeader } from "@/lib/preview/caseTileGrouping";
import { projectTileGrid } from "@/lib/preview/caseTileLayout";
import { tileResultsColumns } from "@/lib/preview/caseTileRendering";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { tileFixture, tileScenarios } from "./tileFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

/** Native HQ regeneration and Core SuiteParser replay use these same documents. */
describe("delivered case tiles", () => {
	it.each(tileScenarios)(
		"%s preserves layout, ordering, and navigation",
		(scenario) => {
			const doc = tileFixture(scenario);
			blueprintDocSchema.parse(toPersistableDoc(doc));
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const hq = expandDoc(doc);
			const zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
			const suite = readXmlEvidence(zip.readAsText("suite.xml"));
			const details = xmlChildren(suite, "detail");
			const search = scenario === "grouped-search";
			const grouped = scenario.startsWith("grouped-");
			const headerRows = scenario === "grouped-two" ? 2 : 1;
			const tiled = scenario !== "plain";
			expect(details.map((detail) => detail.attributes.id)).toEqual(
				search
					? [
							"m0_case_short",
							"m0_case_long",
							"m0_search_short",
							"m0_search_long",
						]
					: ["m0_case_short", "m0_case_long"],
			);
			for (const detail of details) {
				const short = detail.attributes.id.endsWith("short");
				const fields = xmlChildren(detail, "field");
				expect(fields).toHaveLength(short ? 4 : 3);
				expect(
					fields.flatMap((field) => xmlChildren(field, "style")).length,
				).toBe(short && tiled ? 3 : 0);
				if (short && tiled) {
					const styles = fields
						.slice(0, 3)
						.map((field) => onlyXml(xmlChildren(field, "style")));
					expect(styles.map((style) => style.attributes)).toEqual([
						{
							"horz-align": "left",
							"vert-align": "start",
							"font-size": "large",
							...(scenario === "boxed"
								? { "show-border": "true", "show-shading": "true" }
								: {}),
						},
						{
							"horz-align": "center",
							"vert-align": "center",
							"font-size": "medium",
						},
						{
							"horz-align": "right",
							"vert-align": "end",
							"font-size": "medium",
						},
					]);
					expect(
						styles.map(
							(style) => onlyXml(xmlChildren(style, "grid")).attributes,
						),
					).toEqual([
						{
							"grid-x": "0",
							"grid-y": "0",
							"grid-width": "4",
							"grid-height": String(headerRows),
						},
						{
							"grid-x": "0",
							"grid-y": String(headerRows),
							"grid-width": "2",
							"grid-height": "1",
						},
						{
							"grid-x": "2",
							"grid-y": String(headerRows),
							"grid-width": "2",
							"grid-height": "1",
						},
					]);
				}
				if (short) {
					const carrier = fields[3];
					expect(xmlChildren(carrier, "style")).toEqual([]);
					expect(onlyXml(xmlChildren(carrier, "header")).attributes.width).toBe(
						"0",
					);
					expect(
						onlyXml(xmlChildren(carrier, "template")).attributes.width,
					).toBe("0");
					const sort = onlyXml(xmlChildren(carrier, "sort"));
					expect(sort.attributes).toEqual({
						type: "string",
						order: "1",
						direction: "ascending",
						blanks: "first",
					});
					expect(
						onlyXml(xmlChildren(onlyXml(xmlChildren(sort, "text")), "xpath"))
							.attributes.function,
					).toBe("rank");
				}
				expect(
					xmlChildren(detail, "group").map((group) => group.attributes),
				).toEqual(
					short && grouped
						? [
								{
									function: "string(./index/parent)",
									"header-rows": String(headerRows),
								},
							]
						: [],
				);
				// HQ assigns the tile group with the tile's fields, and the select
				// text after both (`DetailContributor.build_detail`).
				if (short && grouped)
					expect(detail.children.slice(-2).map((child) => child.name)).toEqual([
						"group",
						"select_text",
					]);
			}
			const entries = xmlChildren(suite, "entry");
			expect(
				entries.map(
					(entry) => onlyXml(xmlChildren(entry, "command")).attributes.id,
				),
			).toEqual(
				scenario === "grouped-browse" ? ["m0-case-list"] : ["m0-f0", "m0-f1"],
			);
			const datums = xmlChildren(
				onlyXml(xmlChildren(entries[0], "session")),
				"datum",
			);
			const selection = datums[0];
			expect(selection.attributes).toMatchObject({
				id: "case_id",
				"detail-select": "m0_case_short",
				"detail-confirm": "m0_case_long",
			});
			expect(selection.attributes["detail-persistent"]).toBe(
				scenario === "persistent" ? "m0_case_short" : undefined,
			);
			expect(datums.slice(1).map((datum) => datum.attributes)).toEqual(
				grouped && scenario !== "grouped-browse"
					? [
							{
								id: "case_id_parent_ids",
								function:
									"join(' ', distinct-values(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent))",
							},
						]
					: [],
			);
			if (scenario === "grouped-browse")
				expect(xmlChildren(entries[0], "form")).toEqual([]);
			else {
				const registration = xmlChildren(
					onlyXml(xmlChildren(entries[1], "session")),
					"datum",
				);
				expect(registration).toHaveLength(1);
				expect(registration[0].attributes.function).toBe("uuid()");
				expect(registration[0].attributes.nodeset).toBeUndefined();
				expect(registration[0].attributes["detail-persistent"]).toBeUndefined();
			}
			const wire = hq.modules[0].case_details;
			expect(wire.short.case_tile_template).toBe(tiled ? "custom" : null);
			expect(wire.short.persist_tile_on_forms).toBe(
				scenario === "persistent" ? true : null,
			);
			expect(wire.long.case_tile_template).toBeNull();
			const placement = (column: (typeof wire.short.columns)[number]) => ({
				x: column.grid_x,
				y: column.grid_y,
				width: column.width,
				height: column.height,
				horizontal: column.horizontal_align,
				vertical: column.vertical_align,
				font: column.font_size,
				border: column.show_border,
				shading: column.show_shading,
			});
			const unplaced = {
				x: null,
				y: null,
				width: null,
				height: null,
				horizontal: null,
				vertical: null,
				font: null,
				border: null,
				shading: null,
			};
			expect(wire.long.columns.map(placement)).toEqual([
				unplaced,
				unplaced,
				unplaced,
			]);
			expect(wire.short.columns.map(placement)).toEqual(
				tiled
					? [
							{
								x: 0,
								y: 0,
								width: 4,
								height: headerRows,
								horizontal: "left",
								vertical: "start",
								font: "large",
								border: scenario === "boxed" ? true : null,
								shading: scenario === "boxed" ? true : null,
							},
							{
								x: 0,
								y: headerRows,
								width: 2,
								height: 1,
								horizontal: "center",
								vertical: "center",
								font: "medium",
								border: null,
								shading: null,
							},
							{
								x: 2,
								y: headerRows,
								width: 2,
								height: 1,
								horizontal: "right",
								vertical: "end",
								font: "medium",
								border: null,
								shading: null,
							},
						]
					: [unplaced, unplaced, unplaced, unplaced],
			);

			// A tile's hidden order column is no stored column: its rule is a
			// sort row with none, for which HQ appends its own carrier field.
			// A list with no tile stores it as an `invisible` column.
			expect(wire.short.columns).toHaveLength(tiled ? 3 : 4);
			expect(wire.long.columns).toHaveLength(3);
			if (!tiled)
				expect(wire.short.columns[3]).toMatchObject({
					field: "rank",
					format: "invisible",
					useXpathExpression: false,
				});
			expect(
				wire.short.sort_elements.map((element) => [
					element.field,
					element.type,
					element.direction,
					element.blanks,
				]),
			).toEqual([["rank", "plain", "ascending", "first"]]);
			expect(wire.short.case_tile_group).toEqual(
				grouped
					? {
							doc_type: "CaseTileGroupConfig",
							index_identifier: "parent",
							header_rows: headerRows,
						}
					: undefined,
			);
			expect(wire.long.case_tile_group).toBeUndefined();
		},
	);

	it.each(["tile", "grouped-one", "grouped-two"] as const)(
		"%s preview carries only the placed columns, with no field for the hidden order column",
		(scenario) => {
			const doc = tileFixture(scenario);
			const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
			if (!config) throw new Error("Missing fixture case list");
			const columns = tileResultsColumns(
				orderedColumns(config, "list"),
				config.tile,
			);
			expect(columns.map((column) => column.column.uuid)).toEqual(
				config.columns.slice(0, 3).map((column) => column.uuid),
			);
			expect(columns.map((column) => column.valueHidden)).toEqual([
				false,
				false,
				false,
			]);
			const grid = projectTileGrid(columns.map((column) => column.column));
			expect(grid.cells.map((cell) => cell.columnUuid)).toEqual(
				config.columns.slice(0, 3).map((column) => column.uuid),
			);
			expect(grid.cells.map((cell) => cell.mode)).toEqual([
				"flow",
				"flow",
				"flow",
			]);
			expect(grid.columns).toBe(4);
			expect(grid.rows).toBe(scenario === "grouped-two" ? 3 : 2);
			if (config.tile?.grouping) {
				const split = splitTileGridByGroupHeader(
					grid,
					config.tile.grouping.headerRows,
				);
				expect(split.header.cells.map((cell) => cell.columnUuid)).toEqual([
					config.columns[0].uuid,
				]);
				expect(split.body.cells.map((cell) => cell.columnUuid)).toEqual(
					config.columns.slice(1, 3).map((column) => column.uuid),
				);
				expect(summarizeBlueprint(doc)).toContain(
					"grouped_by: parent connection",
				);
			}
		},
	);
});
