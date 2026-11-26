/**
 * Lookup column names with letters outside ASCII, shown and saved by a select
 * (`targeted-lookup-non-ascii-names`).
 *
 * CommCare HQ's form builder reads a form's expressions with js-xpath, whose
 * names are unaccented letters, digits, `_`, `.` and `-`. It compares a
 * select's label and value refs with the table's names as text, so a select
 * over `zones_b` showing `région` and saving `clé` keeps them through its two
 * saves (proof 4), and Core's session reads the table (intent).
 *
 * A form reading a table whose tag is outside those names, or form logic
 * reading such a column, is refused
 * (`expressions-and-data/non-ascii-lookup-name-a-form-reads`). Before that
 * refusal this document also read a table tagged `ζωνες` in a select, and both
 * tables in calculations: the form builder dropped the `item-list:ζωνες`
 * declaration, so HQ refused the form ("Instance: item-list:ζωνες Does not
 * exists"), and saved each calculation as `zones_b[clé = #form/area]`, which
 * HQ's build refused.
 *
 * Fixed values: the restore holds the table as HQ's restore serves it. The
 * worker picks its second row.
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

const ID = "targeted-lookup-non-ascii-names";
const uuid = (name: string) => targetedUuid(ID, name);

const COLUMNS = ["clé", "région"] as const;
const ROWS = [
	["haut", "Hautes terres"],
	["bas", "Basses terres"],
] as const;

export function lookupNonAsciiNames() {
	const tables = (["zones_b"] as const).map((tag) => {
		const definition = wireTable(
			tag,
			COLUMNS.map((name) => ({ name, type: "text" as const })),
		);
		const [code, region] = definition.columns;
		if (code === undefined || region === undefined)
			throw new Error(`The ${tag} table has no ${COLUMNS.join(", ")} columns.`);
		const question = "area";
		return {
			definition,
			code,
			region,
			question,
			rows: ROWS.map(([key, label]) =>
				wireRow(definition, key, { clé: key, région: label }),
			),
		};
	});
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Zones",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: tables.map(({ definition, code, region, question }) =>
							f({
								kind: "single_select",
								uuid: uuid(question),
								id: question,
								label: proseText("Zone"),
								optionsSource: {
									kind: "lookup",
									tableId: definition.id,
									valueColumnId: code.id,
									labelColumnId: region.id,
								},
							}),
						),
					},
				],
			},
		],
	});
	const lookup = {
		projectId: "project-targeted-lookup",
		projectRevision: parseLookupRevision("1"),
		definitions: tables.map(({ definition }) => definition),
		rowsByTable: new Map(
			tables.map(({ definition, rows }) => [definition.id, rows] as const),
		),
	};
	const restore = restoreXml({
		tables: tables.map(({ definition }) => ({
			tag: definition.tag,
			fields: [...COLUMNS],
			rows: ROWS.map((row) => [...row]),
		})),
	});
	const expectation = (exportName: "local" | "A") => ({
		id: `regions-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		restore: "restore.xml",
		request: {
			// A select is answered by its choice's 1-based position.
			answers: tables.map(({ question }) => ({
				path: `/data/${question}`,
				value: "2",
			})),
			expressions: tables.map(({ question }) => `/data/${question}`),
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/values/0/value", value: "bas" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["expressions-and-data/tag-or-field-name-with-non-ascii-letters"],
		doc,
		lookup,
		expected: { intent: [expectation("local"), expectation("A")] },
		files: { "restore.xml": restore },
	});
}
