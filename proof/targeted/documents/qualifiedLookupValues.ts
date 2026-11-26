import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
	wireUuid,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { proseText } from "@/lib/domain";
import {
	eq,
	formField,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression";
import { lookupMemberIdSchema } from "@/lib/domain/lookupIds";
import { targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-qualified-lookup-values";
const member = (name: string) => ({
	id: lookupMemberIdSchema.parse(wireUuid(ID + name)),
	wireName: name,
	label: name,
});
export function qualifiedLookupValues() {
	const table = wireTable("clinics", [{ name: "name", type: "text" }]);
	const code = member("code"),
		lang = member("lang");
	const column = {
		...table.columns[0],
		repeated: true as const,
		properties: [lang],
	};
	table.attributes = [code];
	table.columns = [column];
	const clinic = targetedUuid(ID, "clinic"),
		visit = targetedUuid(ID, "visit");
	const places = [
		["north", "North", "Nord"],
		["east", "East", "Est"],
	];
	const rows = places.map(([value, en, fr]) => ({
		...wireRow(table, value, {}),
		attributes: { [code.id]: value },
		occurrences: {
			[column.id]: [
				{ text: en, properties: { [lang.id]: "en" } },
				{ text: fr, properties: { [lang.id]: "fr" } },
			],
		},
	}));
	const where = { propertyId: lang.id, equals: "fr" };
	const french = { columnId: column.id, where, occurrence: 1 };
	const byChoice = eq(
		tableColumn(table.id, { attributeId: code.id }),
		formField(clinic),
	);
	const doc = buildDoc({
		appId: ID,
		appName: "Clinic visit",
		modules: [
			{
				uuid: targetedUuid(ID, "visits"),
				name: "Clinic visits",
				forms: [
					{
						uuid: visit,
						name: "Log visit",
						type: "survey",
						fields: [
							f({
								uuid: clinic,
								id: "clinic",
								kind: "single_select",
								label: proseText("Clinic"),
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: { attributeId: code.id },
									labelColumnId: french,
								},
							}),
							f({
								uuid: targetedUuid(ID, "display"),
								id: "display",
								kind: "hidden",
								calculate: tableLookup(table.id, french, byChoice),
							}),
							f({
								uuid: targetedUuid(ID, "language"),
								id: "language",
								kind: "hidden",
								calculate: tableLookup(
									table.id,
									{ ...french, propertyId: lang.id },
									byChoice,
								),
							}),
							f({
								uuid: targetedUuid(ID, "first"),
								id: "first",
								kind: "hidden",
								calculate: tableLookup(
									table.id,
									{ ...french, positionBeforeFilter: true },
									byChoice,
								),
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		richTables: [
			{
				tag: "clinics",
				rows: places.map(([code, en, fr]) => ({
					attributes: { code },
					fields: [
						{ name: "name", text: en, attributes: { lang: "en" } },
						{ name: "name", text: fr, attributes: { lang: "fr" } },
					],
				})),
			},
		],
	});
	return targetedDocument({
		id: ID,
		doc,
		rows: [
			"questions/itemset-refs-to-attr-or-property-qualified-fields",
			"expression reads of ordered occurrences and their properties",
		],
		lookup: {
			projectId: ID,
			projectRevision: table.definitionRevision,
			definitions: [table],
			rowsByTable: new Map([[table.id, rows]]),
		},
		files: { "restore.xml": restore },
		expected: {
			intent: (["local", "A"] as const).map((mode) => ({
				id: `worker-selects-east-${mode.toLowerCase()}`,
				export: mode,
				form: visit,
				restore: "restore.xml",
				request: {
					// A select is answered by its choice's 1-based position, as Web Apps sends
					// Formplayer: "east" is the second row's choice. Core's choices, read
					// back below, show the attribute as each value and the French
					// occurrence as each label.
					answers: [{ path: "/data/clinic", value: "2" }],
					expressions: [
						"/data/clinic",
						"/data/display",
						"/data/language",
						"/data/first",
					],
				},
				expect: [
					{ pointer: "/answers/0/result", value: "ok" },
					{ pointer: "/answers/0/choices/0/value", value: "north" },
					{ pointer: "/answers/0/choices/0/text", value: "Nord" },
					{ pointer: "/answers/0/choices/1/value", value: "east" },
					{ pointer: "/answers/0/choices/1/text", value: "Est" },
					{ pointer: "/values/0/value", value: "east" },
					{ pointer: "/values/1/value", value: "Est" },
					{ pointer: "/values/2/value", value: "fr" },
					{ pointer: "/values/3/value", value: "" },
				],
			})),
		},
	});
}
