/**
 * Lookup names with letters outside ASCII, read in a form
 * (`targeted-lookup-non-ascii-names`).
 *
 * CommCare HQ's form builder reads XPath with js-xpath, whose names are
 * unaccented letters, digits, `_`, `.` and `-`. It keeps an instance
 * declaration it finds a read of, or one whose id is a data source HQ hands
 * it (`item-list:<tag>`), and on `hq-lookup-names` it dropped a bare `ζωνες`
 * declaration on save while keeping HQ's own `item-list:ζωνες`. So Nova
 * declares a tag outside js-xpath's names under its fixture id
 * (`lib/commcare/lookup/naming.ts::lookupXformInstanceId`), and keeps a tag
 * inside them bare.
 *
 * Two tables hold the same two columns, `clé` and `région`: `ζωνες`, whose
 * tag is Greek, and `zones_b`, whose tag is ASCII. Each is read by a select
 * whose choices come from it and by a calculation reading `région` by the
 * chosen `clé`, so the form builder's two saves (proof 4) meet a declaration
 * read only through names it cannot lex, and Core's session reads both
 * tables (intent).
 *
 * Fixed values: the restore holds both tables as HQ's restore serves them.
 * The worker picks each table's second row.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { proseText } from "@/lib/domain";
import {
	eq,
	formField,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression";
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
	const tables = (["ζωνες", "zones_b"] as const).map((tag, index) => {
		const definition = wireTable(
			tag,
			COLUMNS.map((name) => ({ name, type: "text" as const })),
		);
		const [code, region] = definition.columns;
		if (code === undefined || region === undefined)
			throw new Error(`The ${tag} table has no ${COLUMNS.join(", ")} columns.`);
		const question = index === 0 ? "zone" : "area";
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
						fields: tables.flatMap(({ definition, code, region, question }) => [
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
							f({
								kind: "hidden",
								uuid: uuid(`${question}_region`),
								id: `${question}_region`,
								calculate: tableLookup(
									definition.id,
									region.id,
									eq(
										tableColumn(definition.id, code.id),
										formField(uuid(question)),
									),
								),
							}),
						]),
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
			expressions: tables.flatMap(({ question }) => [
				`/data/${question}`,
				`/data/${question}_region`,
			]),
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/answers/1/result", value: "ok" },
			{ pointer: "/values/0/value", value: "bas" },
			{ pointer: "/values/1/value", value: "Basses terres" },
			{ pointer: "/values/2/value", value: "bas" },
			{ pointer: "/values/3/value", value: "Basses terres" },
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
