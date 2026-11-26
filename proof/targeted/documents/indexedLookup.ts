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
import { targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-indexed-lookup";
const sites = [
	{ code: "west", name: "West clinic" },
	{ code: "east", name: "East clinic" },
];

export function indexedLookup() {
	const table = wireTable("service_sites", [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const code = { ...table.columns[0], index: "indexed" as const };
	const name = table.columns[1];
	table.columns = [code, name];
	const query = targetedUuid(ID, "query");
	const visit = targetedUuid(ID, "visit");
	const doc = buildDoc({
		appId: ID,
		appName: "Find a service site",
		modules: [
			{
				uuid: targetedUuid(ID, "sites"),
				name: "Service sites",
				forms: [
					{
						uuid: visit,
						name: "Find a clinic",
						type: "survey",
						fields: [
							f({
								uuid: query,
								id: "site_code",
								kind: "text",
								label: proseText("Site code"),
							}),
							f({
								uuid: targetedUuid(ID, "found"),
								id: "site_name",
								kind: "hidden",
								calculate: tableLookup(
									table.id,
									name.id,
									eq(tableColumn(table.id, code.id), formField(query)),
								),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		doc,
		rows: ["typed equality lookup against an indexed HQ field"],
		lookup: {
			projectId: ID,
			projectRevision: table.definitionRevision,
			definitions: [table],
			rowsByTable: new Map([
				[table.id, sites.map((site) => wireRow(table, site.code, site))],
			]),
		},
		files: {
			"restore.xml": restoreXml({
				tables: [
					{
						tag: table.tag,
						fields: ["code", "name"],
						rows: sites.map(({ code, name }) => [code, name]),
					},
				],
			}),
		},
		expected: {
			intent: [...sites, { code: "absent", name: "" }].map(
				({ code, name }) => ({
					id: `find-site-${code}`,
					export: "A",
					form: visit,
					restore: "restore.xml",
					request: {
						answers: [{ path: "/data/site_code", value: code }],
						expressions: ["/data/site_name"],
					},
					expect: [
						{ pointer: "/answers/0/result", value: "ok" },
						{ pointer: "/values/0/value", value: name },
					],
				}),
			),
		},
	});
}
