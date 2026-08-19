/**
 * Grouped-tile emission, asserted against CommCare HQ's own bytes.
 *
 * The byte oracle is HQ's inline assertion, not a fixture file:
 * `commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles_grouping.py::SuiteCaseTilesGroupingTest`
 * pins `<group function="string(./index/parent)" header-rows="3"/>` and
 * the companion `<datum id="case_id_parent_ids" …>` as
 * `assertXmlPartialEqual` partials. HQ files some shapes as fixture
 * files and some as inline partials; both are equally its canonical
 * bytes.
 *
 * Beware the three upstream `<group>` fixtures that misspell the
 * attribute `grid-header-rows` — they parse as an unknown attribute and
 * silently take the client's default, so they prove nothing. The one
 * correctly-spelled full-suite fixture is
 * `formplayer/src/test/resources/archives/case_list_auto_select/suite.xml`,
 * where `<group>` is the last child of its `<detail>`.
 *
 * Four facts this file exists to hold still:
 *
 *   - BOTH short details carry the group. HQ's gate is
 *     `self.detail_type.endswith('short')` inside
 *     `suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail`,
 *     and `models/modules.py::ModuleDetailsMixin.get_details` supplies
 *     `search_short` from a deep copy of the short detail — so a
 *     search-enabled grouped module emits the group twice. The long
 *     detail never does.
 *   - `header-rows` is always written. The client falls back to `1` and
 *     HQ's model to `2`, so an omitted attribute halves or doubles the
 *     header depending on which side reads the app.
 *   - The companion datum rides ONLY a case-loading form entry.
 *     `entries.py::EntriesHelper.get_case_datums_basic_module` calls
 *     `get_extra_case_id_datums` under `if form:` with the trailing
 *     case-selection datum, so a registration form's entry (no case
 *     datum) and the standalone case-list browse entry (no form) both
 *     go without.
 *   - The HQ JSON writer carries the same grouping, because that is the
 *     PRIMARY delivery path and the one where a tile fact has silently
 *     diverged before.
 */

import AdmZip from "adm-zip";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import type { BlueprintDoc, Module } from "@/lib/domain";
import { tileCell } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const GROUPING = { identifier: "parent", headerRows: 2 } as const;

/**
 * A grouped tile whose top two rows are the header (the parent's name
 * and village) and whose third row is each child's own visit date, so
 * the boundary is a real cut of the layout.
 */
function groupedModule(overrides: Partial<Module> = {}): Partial<Module> {
	const base = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "village", header: "Village" },
		{ field: "visit_date", header: "Visited" },
	]);
	return {
		name: "Visits",
		caseType: "visit",
		caseListConfig: {
			...base,
			columns: [
				{ ...base.columns[0], tile: tileCell(0, 0, 12, 1) },
				{ ...base.columns[1], tile: tileCell(0, 1, 12, 1) },
				{ ...base.columns[2], tile: tileCell(0, 2, 12, 1) },
			],
			tile: { grouping: { ...GROUPING } },
		},
		...overrides,
	} as Partial<Module>;
}

function groupedDoc(spec: {
	readonly search?: boolean;
	readonly registrationForm?: boolean;
	readonly caseListOnly?: boolean;
}): BlueprintDoc {
	return buildDoc({
		appName: "GroupedTiles",
		modules: [
			{
				...(groupedModule() as object),
				...(spec.search === true && {
					caseSearchConfig: { searchScreenTitle: "Find a visit" },
				}),
				...(spec.caseListOnly === true && { caseListOnly: true }),
				forms:
					spec.caseListOnly === true
						? []
						: [
								{
									name: "Record visit",
									type: "followup" as const,
									fields: [
										f({ kind: "text", id: "notes", label: proseText("Notes") }),
									],
								},
								...(spec.registrationForm === true
									? [
											{
												name: "New visit",
												type: "registration" as const,
												fields: [
													f({
														kind: "text",
														id: "case_name",
														label: proseText("Name"),
														caseWrite: {
															caseType: "visit",
															property: "case_name",
														},
													}),
												],
											},
										]
									: []),
							],
			},
		],
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
					{ name: "visit_date", label: proseText("Visited") },
				],
			},
		],
	} as Parameters<typeof buildDoc>[0]);
}

function suiteXml(doc: BlueprintDoc): string {
	const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
	const entry = zip.getEntry("suite.xml");
	if (entry === null) throw new Error("compileCcz produced no suite.xml");
	return entry.getData().toString("utf-8");
}

/**
 * Every `<detail>`'s child element names plus each `<group>`'s
 * attributes, keyed by detail id. Structural, not a string diff — the
 * child ORDER is what proves the group lands last.
 */
function detailShapes(
	xml: string,
): Map<string, { children: string[]; group?: Record<string, string> }> {
	const shapes = new Map<
		string,
		{ children: string[]; group?: Record<string, string> }
	>();
	const stack: string[] = [];
	let currentId: string | undefined;
	let depth = 0;
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				if (name === "detail" && currentId === undefined) {
					currentId = attribs.id;
					shapes.set(currentId, { children: [] });
					depth = 0;
				}
				if (currentId !== undefined) {
					if (depth === 1) {
						const shape = shapes.get(currentId);
						if (shape !== undefined) {
							shape.children.push(name);
							if (name === "group") shape.group = { ...attribs };
						}
					}
					depth += 1;
				}
				stack.push(name);
			},
			onclosetag() {
				stack.pop();
				if (currentId === undefined) return;
				depth -= 1;
				if (depth === 0) currentId = undefined;
			},
		},
		{ xmlMode: true },
	);
	parser.write(xml);
	parser.end();
	return shapes;
}

/**
 * Every `<entry>`'s SESSION datum ids and functions, keyed by command
 * id. Scoped to `<session>` deliberately: an end-of-form `<stack>`
 * carries `<datum>` children of its own that name the value being
 * pushed onto the next frame, and folding those in would report a
 * second `case_id` that has nothing to do with the entry's datum
 * vector.
 */
function entryDatums(
	xml: string,
): Map<string, { id: string; function?: string }[]> {
	const entries = new Map<string, { id: string; function?: string }[]>();
	let datums: { id: string; function?: string }[] | undefined;
	let commandId: string | undefined;
	let inSession = false;
	const parser = new Parser(
		{
			onopentag(name, attribs) {
				if (name === "entry") {
					datums = [];
					commandId = undefined;
				}
				if (datums === undefined) return;
				if (name === "session") inSession = true;
				if (name === "command" && commandId === undefined) {
					commandId = attribs.id;
				}
				if (inSession && (name === "datum" || name === "instance-datum")) {
					datums.push({
						id: attribs.id,
						...(attribs.function !== undefined && {
							function: attribs.function,
						}),
					});
				}
			},
			onclosetag(name) {
				if (name === "session") inSession = false;
				if (name !== "entry" || datums === undefined) return;
				entries.set(commandId ?? "(unnamed)", datums);
				datums = undefined;
			},
		},
		{ xmlMode: true },
	);
	parser.write(xml);
	parser.end();
	return entries;
}

describe("grouped tiles emit CommCare HQ's `<group>` bytes", () => {
	it("puts the group last on the short detail and nowhere else", () => {
		const shapes = detailShapes(suiteXml(groupedDoc({})));

		const short = shapes.get("m0_case_short");
		if (short === undefined) throw new Error("expected a short detail");
		// HQ's own inline partial, attribute for attribute.
		expect(short.group).toEqual({
			function: "string(./index/parent)",
			"header-rows": "2",
		});
		// Last child, after the fields — HQ assigns `detail.tile_group`
		// after the fields, and the correctly-spelled fixture agrees.
		expect(short.children.at(-1)).toBe("group");
		expect(short.children.filter((name) => name === "group")).toHaveLength(1);

		// The case-detail screen stays a plain field list.
		expect(shapes.get("m0_case_long")?.group).toBeUndefined();
	});

	it("groups the search-results detail too, and keeps the action before it", () => {
		const shapes = detailShapes(suiteXml(groupedDoc({ search: true })));

		expect(shapes.get("m0_search_short")?.group).toEqual({
			function: "string(./index/parent)",
			"header-rows": "2",
		});
		expect(shapes.get("m0_search_long")?.group).toBeUndefined();

		// The case-target detail carries both an `<action>` and the group.
		const short = shapes.get("m0_case_short");
		if (short === undefined) throw new Error("expected a short detail");
		expect(short.children.at(-1)).toBe("group");
		expect(short.children.at(-2)).toBe("action");
	});

	it("writes header-rows explicitly rather than leaning on either default", () => {
		const doc = groupedDoc({});
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (config?.tile?.grouping === undefined) {
			throw new Error("expected a grouped tile");
		}
		// One row of header is exactly the value the CLIENT would have
		// guessed and HQ would not, so it is the value that proves the
		// attribute is really on the wire.
		const oneRow: BlueprintDoc = {
			...doc,
			modules: {
				...doc.modules,
				[module.uuid]: {
					...module,
					caseListConfig: {
						...config,
						tile: { grouping: { identifier: "parent", headerRows: 1 } },
					},
				},
			},
		};
		expect(detailShapes(suiteXml(oneRow)).get("m0_case_short")?.group).toEqual({
			function: "string(./index/parent)",
			"header-rows": "1",
		});
	});

	it("adds the companion datum to a case-loading form entry only", () => {
		const entries = entryDatums(
			suiteXml(groupedDoc({ registrationForm: true })),
		);

		const followup = entries.get("m0-f0");
		if (followup === undefined) throw new Error("expected a followup entry");
		expect(followup).toEqual([
			{ id: "case_id" },
			{
				id: "case_id_parent_ids",
				function:
					"join(' ', distinct-values(instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent))",
			},
		]);

		// A registration form selects no case, so CCHQ's `case_datum` is
		// null and no companion datum is emitted.
		const registration = entries.get("m0-f1");
		if (registration === undefined) {
			throw new Error("expected a registration entry");
		}
		expect(registration.some((datum) => datum.id.endsWith("_parent_ids"))).toBe(
			false,
		);
	});

	it("leaves the standalone case-list browse entry alone", () => {
		const entries = entryDatums(suiteXml(groupedDoc({ caseListOnly: true })));
		const allDatums = [...entries.values()].flat();
		expect(allDatums.length).toBeGreaterThan(0);
		expect(allDatums.some((datum) => datum.id.endsWith("_parent_ids"))).toBe(
			false,
		);
	});

	it("emits nothing when the tile is not grouped", () => {
		const doc = groupedDoc({});
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (config === undefined) throw new Error("expected a case-list config");
		const ungrouped: BlueprintDoc = {
			...doc,
			modules: {
				...doc.modules,
				[module.uuid]: {
					...module,
					caseListConfig: { ...config, tile: {} },
				},
			},
		};
		const xml = suiteXml(ungrouped);
		expect(detailShapes(xml).get("m0_case_short")?.group).toBeUndefined();
		expect(
			[...entryDatums(xml).values()]
				.flat()
				.some((datum) => datum.id.endsWith("_parent_ids")),
		).toBe(false);
	});

	it("carries the grouping onto the HQ JSON short detail", () => {
		const doc = groupedDoc({});
		const module = doc.modules[doc.moduleOrder[0]];
		const { caseDetails } = projectCaseListForHq(module, doc);

		expect(caseDetails.short.case_tile_group).toEqual({
			doc_type: "CaseTileGroupConfig",
			index_identifier: "parent",
			header_rows: 2,
		});
		// The long detail is not a tile at all, so it never carries one.
		expect(caseDetails.long.case_tile_group).toBeUndefined();
	});

	it("omits case_tile_group from HQ JSON when the tile is not grouped", () => {
		const doc = groupedDoc({});
		const module = doc.modules[doc.moduleOrder[0]];
		const config = module.caseListConfig;
		if (config === undefined) throw new Error("expected a case-list config");
		const { caseDetails } = projectCaseListForHq(
			{ ...module, caseListConfig: { ...config, tile: {} } },
			doc,
		);
		// Absence is the correct spelling: CCHQ's `Detail.wrap`
		// default-constructs `CaseTileGroupConfig()` with a null
		// `index_identifier`, which `Module.has_grouped_tiles` reads as
		// ungrouped.
		expect(caseDetails.short.case_tile_group).toBeUndefined();
	});
});
