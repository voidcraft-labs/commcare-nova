/**
 * A form's logic and its after-submit links reading a Project data table and
 * the worker's places (`targeted-instance-reads`).
 *
 * "Region visit" is a survey whose hidden values read the regions table by
 * its tag (the first row whose code matches, `table-lookup`, and a count of
 * its rows, `table-rows`) and the flat location fixture (the clinic's name
 * and its ward, a location data field), and whose two links each read one of
 * them in their condition: a place's name, which puts the `locations`
 * instance on the form's suite entry, where HQ's
 * `suite_xml/post_process/instances.py::location_fixture_instances` chooses
 * its source (`hierarchical_locations` reads it), and `item-list:regions`,
 * which HQ declares on that entry too.
 *
 * The levels, the ward and the places are those of the location family's
 * "skipped" fixture (`proof/native/steps/location_emission.py`): a region and
 * a clinic directly under it, which HQ's own serializer writes, so
 * `LocationOwnerRuntimeTest` reads this form and its link over HQ's bytes and
 * `LookupRuntimeTest` reads the table the same way.
 *
 * The repeat "visits" counts, in each entry, the regions whose code is the
 * entry's own answer: a form read inside a row predicate that crosses the
 * repeat the calculate is in, which Nova prints `current()/../region`, since
 * Core evaluates such a predicate in the bind's context or row by row and an
 * absolute path names every entry row by row (`formReads.ts`).
 *
 * Fixed values: over a restore holding the regions table and those places,
 * North region holds code `north`, the table holds two rows, and the one
 * clinic is "clinic & North", whose ward is "A & B". With two visits
 * answered `north` and `east`, the first counts one region and the second
 * none.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { type OrganizationLevel, proseText } from "@/lib/domain";
import {
	count,
	eq,
	gt,
	literal,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import type { Expression } from "@/lib/domain/expression/types";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

const ID = "targeted-instance-reads";
const uuid = (name: string) => targetedUuid(ID, name);

const LEVELS = ["region", "district", "clinic"].map(
	(code, index): OrganizationLevel => ({
		uuid: uuid(`level-${code}`),
		code,
		name: code,
		...(index > 0 && {
			parentLevelUuid: uuid(`level-${index === 1 ? "region" : "district"}`),
		}),
		caseFlow: { workers: "none", ownsCases: false },
		addressBook: { reach: "own-branch" },
	}),
);
const [, , CLINIC] = LEVELS;
const WARD = uuid("ward");
const UNSET = uuid("unset");
const CLINIC_NAME = "clinic & North";

/** `instance('locations')/locations/location[@type = 'clinic']/<value>` */
function clinic(
	value: Extract<Expression, { kind: "project" }>["value"],
): Expression {
	if (CLINIC === undefined) throw new Error("The clinic level is missing.");
	return {
		kind: "project",
		of: {
			kind: "locations",
			where: [
				eq(
					term({ kind: "location-field", field: "type" }),
					term({ kind: "location-level", levelUuid: CLINIC.uuid }),
				),
			],
		},
		value,
	};
}

export function instanceReads() {
	const table = wireTable("regions", [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const [code, name] = table.columns;
	if (code === undefined || name === undefined)
		throw new Error("The regions table has no code and name columns.");
	const rows = [
		wireRow(table, "north", { code: "north", name: "North region" }),
		wireRow(table, "south", { code: "south", name: "South region" }),
	];
	const regionRows: Expression = {
		kind: "table-rows",
		tableId: table.id,
		where: [],
	};
	const module = uuid("module");
	const form = uuid("form");
	const followUp = uuid("follow-up");
	const hidden = (id: string, calculate: Expression) =>
		f({ kind: "hidden", uuid: uuid(id), id, calculate });
	const doc = buildDoc({
		appId: ID,
		appName: "Region visits",
		modules: [
			{
				uuid: module,
				name: "Regions",
				forms: [
					{
						uuid: form,
						name: "Region visit",
						type: "survey",
						postSubmit: "module",
						fields: [
							hidden(
								"region_name",
								tableLookup(
									table.id,
									name.id,
									eq(tableColumn(table.id, code.id), literal("north")),
								),
							),
							hidden("region_count", count(regionRows)),
							hidden(
								"clinic_name",
								clinic({ kind: "location-field", field: "name" }),
							),
							hidden(
								"clinic_ward",
								clinic({
									kind: "location-field",
									field: { property: WARD },
								}),
							),
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
							f({
								kind: "repeat",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({
										kind: "text",
										uuid: uuid("visit-region"),
										id: "region",
										label: proseText("Region"),
									}),
									hidden(
										"same_region",
										count({
											kind: "table-rows",
											tableId: table.id,
											where: [
												eq(
													tableColumn(table.id, code.id),
													term({
														kind: "field",
														uuid: uuid("visit-region"),
													}),
												),
											],
										}),
									),
								],
							}),
						],
						formLinks: [
							{
								uuid: uuid("place-link"),
								condition: eq(
									clinic({ kind: "location-field", field: "name" }),
									term(literal(CLINIC_NAME)),
								),
								target: {
									type: "form",
									moduleUuid: module,
									formUuid: followUp,
								},
							},
							{
								uuid: uuid("table-link"),
								condition: gt(count(regionRows), term(literal(0))),
								target: {
									type: "form",
									moduleUuid: module,
									formUuid: followUp,
								},
							},
						],
					},
					{
						uuid: followUp,
						name: "Clinic follow-up",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("follow-up-note"),
								id: "follow_up_note",
								label: proseText("Follow-up note"),
							}),
						],
					},
				],
			},
		],
	});
	doc.organizationLevels = Object.fromEntries(
		LEVELS.map((level) => [level.uuid, level]),
	);
	doc.organizationLevelOrder = LEVELS.map((level) => level.uuid);
	doc.locationProperties = {
		[WARD]: { uuid: WARD, slug: "ward", label: "Ward" },
		[UNSET]: { uuid: UNSET, slug: "unset", label: "Unset" },
	};
	doc.locationPropertyOrder = [WARD, UNSET];

	const intent: Expectation[] = (["local", "A"] as const).map((exportName) => ({
		id: `table-and-places-${exportName}`,
		export: exportName,
		form,
		restore: "restore.xml",
		request: {
			expressions: [
				"/data/region_name",
				"/data/region_count",
				"/data/clinic_name",
				"/data/clinic_ward",
			],
		},
		expect: [
			{ pointer: "/values/0/value", value: "North region" },
			{ pointer: "/values/1/value", value: "2" },
			{ pointer: "/values/2/value", value: CLINIC_NAME },
			{ pointer: "/values/3/value", value: "A & B" },
		],
	}));
	for (const exportName of ["local", "A"] as const)
		intent.push({
			id: `own-row-count-${exportName}`,
			export: exportName,
			form,
			restore: "restore.xml",
			request: {
				repeats: { "/data/visits": 2 },
				answers: [
					{ path: "/data/visits[1]/region[1]", value: "north" },
					{ path: "/data/visits[2]/region[1]", value: "east" },
				],
				expressions: [
					"/data/visits[1]/same_region[1]",
					"/data/visits[2]/same_region[1]",
				],
			},
			expect: [
				{ pointer: "/answers/0/result", value: "ok" },
				{ pointer: "/answers/1/result", value: "ok" },
				{ pointer: "/values/0/value", value: "1" },
				{ pointer: "/values/1/value", value: "0" },
			],
		});
	const lineage = (region: string, district: string, place: string) => ({
		region,
		district,
		clinic: place,
	});
	return targetedDocument({
		id: ID,
		rows: [
			"form-logic-lookup-reads",
			"flat-location-reads",
			"link-reads",
			"form read inside a row predicate, per repeat entry",
		],
		doc,
		lookup: {
			projectId: `project-${ID}`,
			projectRevision: parseLookupRevision("1"),
			definitions: [table],
			rowsByTable: new Map([[table.id, rows]]),
		},
		expected: { intent },
		files: {
			"restore.xml": restoreXml({
				tables: [
					{
						tag: "regions",
						fields: ["code", "name"],
						rows: [
							["north", "North region"],
							["south", "South region"],
						],
					},
				],
				places: [
					{
						id: "place-1",
						level: "region",
						levelName: "region",
						lineage: lineage("place-1", "", ""),
						name: "region & North",
						siteCode: "site-1",
						data: { ward: "", unset: "" },
					},
					{
						id: "place-3",
						level: "clinic",
						levelName: "clinic",
						lineage: lineage("place-1", "", "place-3"),
						name: CLINIC_NAME,
						siteCode: "site-3",
						data: { ward: "A & B", unset: "" },
					},
				],
			}),
		},
	});
}
