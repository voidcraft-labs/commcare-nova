/**
 * Lookup names with letters outside ASCII, read in a form
 * (`targeted-lookup-non-ascii-names`).
 *
 * CommCare HQ's form builder reads XPath with js-xpath, whose names are
 * unaccented letters, digits, `_`, `.` and `-`, and drops the declaration of
 * an instance whose reads it cannot lex. HQ's build declares a missing
 * instance again only where its id names a scheme HQ knows
 * (`XForm.add_missing_instances`): it declared `item-list:ζωνες` again on
 * `hq-lookup-names`, and refused a bare `ζωνες` ("missing some instance
 * declarations that can't be automatically added"). So Nova declares a tag
 * outside js-xpath's names under its fixture id
 * (`lib/commcare/lookup/naming.ts::lookupXformInstanceId`), and keeps a tag
 * inside them bare.
 *
 * Two tables hold the same two columns, `clé` and `région`: `ζωνες`, whose
 * tag is Greek, and `zones_b`, whose tag is ASCII. A select's choices come
 * from each, showing `région` and saving `clé`: the names HQ's form builder
 * keeps as written. Form logic reading either table's names is refused
 * (`expressions-and-data/non-ascii-lookup-name-in-form-logic`): before that
 * refusal, this document's calculations reading `région` by the chosen `clé`
 * came back from the form builder's save as `zones_b[clé = #form/area]`, which
 * HQ's build refused. Proof 4 holds the two saves to the selects, and Core's
 * session reads both tables (intent).
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
			{ pointer: "/answers/1/result", value: "ok" },
			{ pointer: "/values/0/value", value: "bas" },
			{ pointer: "/values/1/value", value: "bas" },
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
