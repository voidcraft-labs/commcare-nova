/**
 * A lookup table a person keeps in HQ between Nova's publishes, and Nova's
 * next publish over it (the row "5, table content").
 *
 * `targeted-hq-side-lookup` is a survey whose form selects a district from a
 * lookup table. Over Nova's first publish (A), a person keeps the district
 * table in HQ (`hqSide`, `proof/observe/hqside.py`): a property on its `name`
 * field, an attribute and owners on every row, uploaded through HQ's lookup
 * upload, and a description from HQ's table editor. Nova's next push uploads
 * its own workbook for the tag with `replace`, which sees another table
 * (`fixtures/upload/run_upload.py::table_key`), deletes it and makes it
 * again: the table and its rows get new ids, and the property, the
 * attributes, the owners and the description are gone (defect 5, table
 * content).
 *
 * The table has a document of its own, apart from the other saves a person
 * makes in HQ (`./hqSideState.ts`), because its republish is the one Nova
 * stops once defect 5 is fixed, and the other saves' symptoms need a
 * republish that lands.
 *
 * Fixed values: the form holds the note the worker enters (`./echo.ts`), over
 * a restore holding the district table as HQ serves it, which the form's
 * select loads.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { proseText } from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

const ID = "targeted-hq-side-lookup";
const uuid = (name: string) => targetedUuid(ID, name);

const DISTRICTS = "district";

export function hqSideLookup() {
	const table = wireTable(DISTRICTS, [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const [code, name] = table.columns;
	if (code === undefined || name === undefined) {
		throw new Error(`The ${DISTRICTS} table has no code and name columns.`);
	}
	const rows = [
		wireRow(table, "north", { code: "north", name: "North district" }),
		wireRow(table, "south", { code: "south", name: "South district" }),
	];
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "District visits",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: uuid("district"),
								id: "district",
								label: proseText("District"),
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: code.id,
									labelColumnId: name.id,
								},
							}),
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["5, table content"],
		doc,
		lookup: {
			projectId: "project-targeted-hq-side-lookup",
			projectRevision: parseLookupRevision("1"),
			definitions: [table],
			rowsByTable: new Map([[table.id, rows]]),
		},
		// The form selects from the district table, which Core loads with the form, so the note is answered over
		// a restore that holds the table as HQ serves it.
		expected: {
			intent: [
				{
					...answerHeld("note-held", form, "/data/note", "seen"),
					restore: "restore.xml",
				},
			],
		},
		files: {
			"restore.xml": restoreXml({
				tables: [
					{
						tag: DISTRICTS,
						fields: ["code", "name"],
						rows: [
							["north", "North district"],
							["south", "South district"],
						],
					},
				],
			}),
		},
		hqSide: {
			lookupTable: {
				tag: DISTRICTS,
				fieldProperty: { field: "name", property: "lang", value: "en" },
				rowAttribute: { name: "zone", values: ["upland", "coastal"] },
				owners: {
					user: "district.lead",
					group: "District leads",
					location: { name: "North district office", siteCode: "north_office" },
				},
				description: "The districts the health team visits",
			},
		},
	});
}
