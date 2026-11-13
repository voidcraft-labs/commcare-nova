/**
 * Lookup table names holding hyphens and an uppercase `XML` start
 * (`targeted-lookup-names`).
 *
 * A tag and a column's wire name start with a letter or an underscore and
 * hold letters, digits, underscores and hyphens, never starting with
 * lowercase `xml` (`lib/lookup/constants.ts::LOOKUP_WIRE_IDENTIFIER_PATTERN`).
 * A tag is a fixture's element names (`<tag>_list`, `<tag>`), its instance id
 * in a form, a workbook sheet's name and a step of every read; a column's
 * wire name is a row's child element and a step. The Project table
 * `health-facility-v2`, with the columns `facility-name`, `XMLcode` and
 * `geo-lat`, is read by:
 *
 * - a select whose choices come from it, saved to the client's `facility`:
 *   `facility-name` is both its value and its label, so each value is a
 *   token with no whitespace, as every choice value is
 *   (`lib/commcare/lookup/selectSourceRows.ts`);
 * - a calculation reading `geo-lat` by a filter on `XMLcode`;
 * - a calculated case list column reading `geo-lat` for the client's facility;
 * - the case list's filter, which compares the client's `facility` with the
 *   `facility-name` the table holds, and which HQ's build interpolates with
 *   a case (`xpath.py::dot_interpolate`);
 * - a display condition on a follow-up form, interpolated with a case, and
 *   one on a survey form in a menu with no case type, interpolated with none.
 *
 * Those last three are the slots CommCare HQ's build rewrites as text, so a
 * hyphenated step it rewrites or refuses shows there.
 *
 * Fixed values: the restore holds the table as HQ's restore serves it, so the
 * survey counts its two rows and reads one row's `geo-lat` by its `XMLcode`.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	calculatedColumn,
	type Expression,
	plainColumn,
	proseText,
} from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	neq,
	prop,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-lookup-names";
const uuid = (name: string) => targetedUuid(ID, name);

const TAG = "health-facility-v2";
const COLUMNS = ["facility-name", "XMLcode", "geo-lat"] as const;

export function lookupNames() {
	const table = wireTable(
		TAG,
		COLUMNS.map((name) => ({ name, type: "text" as const })),
	);
	const [facilityName, code, latitude] = table.columns;
	if (
		facilityName === undefined ||
		code === undefined ||
		latitude === undefined
	)
		throw new Error(`The ${TAG} table has no ${COLUMNS.join(", ")} columns.`);
	const rows = [
		wireRow(table, "north", {
			"facility-name": "north-clinic",
			XMLcode: "N1",
			"geo-lat": "-1.28",
		}),
		wireRow(table, "south", {
			"facility-name": "south-clinic",
			XMLcode: "S1",
			"geo-lat": "-4.04",
		}),
	];
	/** Whether the table holds a row whose `column` equals `value`: the
	 * `facility-name` of the first such row is not blank. */
	const tableHolds = (
		column: typeof code,
		value: Parameters<typeof eq>[1],
	): Expression =>
		neq(
			tableLookup(
				table.id,
				facilityName.id,
				eq(tableColumn(table.id, column.id), value),
			),
			literal(""),
		);
	const survey = uuid("survey");
	const doc = buildDoc({
		appId: ID,
		appName: "Health facilities",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "facility",
						label: proseText("Facility"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("clients"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("name-column"), "case_name", "Name"),
						calculatedColumn(
							uuid("latitude-column"),
							"Latitude",
							tableLookup(
								table.id,
								latitude.id,
								eq(
									tableColumn(table.id, facilityName.id),
									prop("client", "facility"),
								),
							),
						),
					],
					{
						filter: tableHolds(facilityName, prop("client", "facility")),
					},
				),
				forms: [
					{
						uuid: uuid("register"),
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "single_select",
								uuid: uuid("facility"),
								id: "facility",
								label: proseText("Facility"),
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: facilityName.id,
									labelColumnId: facilityName.id,
								},
								caseWrite: { caseType: "client", property: "facility" },
							}),
						],
					},
					{
						uuid: uuid("visit"),
						name: "Visit",
						type: "followup",
						displayCondition: tableHolds(code, literal("N1")),
						fields: [
							f({
								kind: "text",
								uuid: uuid("visit-note"),
								id: "visit_note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("facilities"),
				name: "Facilities",
				forms: [
					{
						uuid: survey,
						name: "Facility check",
						type: "survey",
						displayCondition: tableHolds(code, literal("S1")),
						fields: [
							f({
								kind: "text",
								uuid: uuid("code"),
								id: "code",
								label: proseText("Code"),
							}),
							f({
								kind: "hidden",
								uuid: uuid("latitude"),
								id: "latitude",
								calculate: tableLookup(
									table.id,
									latitude.id,
									eq(tableColumn(table.id, code.id), formField(uuid("code"))),
								),
							}),
						],
					},
				],
			},
		],
	});
	const lookup = {
		projectId: "project-targeted-lookup-names",
		projectRevision: parseLookupRevision("1"),
		definitions: [table],
		rowsByTable: new Map([[table.id, rows]]),
	};
	const restore = restoreXml({
		tables: [
			{
				tag: TAG,
				fields: [...COLUMNS],
				rows: [
					["north-clinic", "N1", "-1.28"],
					["south-clinic", "S1", "-4.04"],
				],
			},
		],
	});
	const expectation = (exportName: "local" | "A") => ({
		id: `table-reads-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form: survey,
		restore: "restore.xml",
		request: {
			answers: [{ path: "/data/code", value: "S1" }],
			expressions: [
				`count(instance('${TAG}')/${TAG}_list/${TAG})`,
				"/data/latitude",
			],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value: "2" },
			{ pointer: "/values/1/value", value: "-4.04" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"names, a lookup tag or column name holding a hyphen or starting XML",
		],
		doc,
		lookup,
		expected: { intent: [expectation("local"), expectation("A")] },
		files: { "restore.xml": restore },
	});
}
