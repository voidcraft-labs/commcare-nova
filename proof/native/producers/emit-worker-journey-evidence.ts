import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	wireRow,
	wireTable,
	wireUuid,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { lookupMemberIdSchema } from "@/lib/domain/lookupIds";
import { caseListOf } from "../../targeted/build";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output) throw new Error("An output directory is required.");
mkdirSync(output, { recursive: true });
const write = (name: string, body: string | Buffer) =>
	writeFileSync(resolve(output, name), body);

const member = (name: string) => ({
	id: lookupMemberIdSchema.parse(wireUuid(`worker-journey-${name}`)),
	wireName: name,
	label: name,
});
const code = member("code");
const lang = member("lang");
const base = wireTable("clinics", [{ name: "name", type: "text" }]);
const column = {
	...base.columns[0],
	repeated: true as const,
	properties: [lang],
};
const table = {
	...base,
	attributes: [code],
	columns: [column],
	workerAccess: "assigned" as const,
};
const venues = [
	["east-one", "Twin clinic", "Clinique jumelle"],
	["east-two", "Twin clinic", "Clinique jumelle"],
	["west-one", "West clinic", "Clinique ouest"],
];
const rows = venues.map(([key, english, french]) => ({
	...wireRow(table, key, {}),
	attributes: { [code.id]: key },
	occurrences: {
		[column.id]: [
			{ text: english, properties: { [lang.id]: "en" } },
			{ text: french, properties: { [lang.id]: "fr" } },
		],
	},
}));
const doc = buildDoc({
	appName: "Clinic rounds",
	appSettings: {
		...NEW_APP_SETTINGS,
		firstMenuLayout: "grid",
		formMenuLayout: "grid",
	},
	caseTypes: [
		{
			name: "person",
			properties: [{ name: "case_name", label: proseText("Name") }],
		},
	],
	modules: [
		{
			name: "Rounds",
			caseType: "person",
			caseListMenuItem: {
				label: "People",
				icon: mediaIds.icon,
				mediaByLanguage: { fra: { icon: mediaIds.option } },
			},
			caseListConfig: caseListOf([
				plainColumn(wireUuid("worker-journey-name"), "case_name", "Name"),
			]),
			forms: [
				{
					name: "Register",
					type: "registration",
					fields: [
						f({
							id: "name",
							kind: "text",
							caseWrite: { caseType: "person", property: "case_name" },
						}),
					],
				},
				{
					name: "Visit",
					type: "followup",
					fields: [
						f({
							id: "clinic",
							kind: "single_select",
							label: proseText("Clinic"),
							label_media: {
								image: mediaIds.label,
								mediaByLanguage: { fra: { image: mediaIds.icon } },
							},
							optionsSource: {
								kind: "lookup",
								tableId: table.id,
								valueColumnId: { attributeId: code.id },
								labelColumnId: {
									columnId: column.id,
									where: { propertyId: lang.id, equals: "fr" },
									occurrence: 1,
								},
							},
						}),
					],
				},
			],
		},
	],
});
doc.localization = {
	sourceLanguage: "eng",
	defaultLanguage: "eng",
	languageOrder: ["eng", "fra"],
	wireCodes: { eng: "en", fra: "fr" },
	translations: {},
};
const assets = new Map(
	[...mediaManifest()].filter(([id]) =>
		[mediaIds.icon, mediaIds.label, mediaIds.option].some(
			(used) => used === id,
		),
	),
);
const naming = lookupWireNaming([table]);
const app = expandDoc(doc, { assets, lookupNaming: naming });
write("app.json", JSON.stringify(app));
write(
	"archive.ccz",
	compileCcz(app, doc.appName, doc, {
		runtimeTarget: NATIVE_RUNTIME_TARGET,
		assets,
		lookup: {
			naming,
			fixtures: buildLookupFixtures(naming, new Map([[table.id, rows]])),
		},
	}),
);
write("media.zip", buildMediaBulkUploadZip(assets));
write(
	"media.json",
	JSON.stringify(
		Object.fromEntries(
			Object.entries({
				menuEnglish: mediaIds.icon,
				menuFrench: mediaIds.option,
				formEnglish: mediaIds.label,
				formFrench: mediaIds.icon,
			}).map(([slot, id]) => [slot, assets.get(id)?.wirePath]),
		),
	),
);
