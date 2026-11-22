import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { testUuid } from "../../../__tests__/helpers/uuid";
import {
	bilingualSurveyDoc,
	SMUGGLING_READ,
	SMUGGLING_SOURCE,
} from "../../../lib/commcare/__tests__/localeSmugglingFixture";
import {
	localizationScenarios,
	localizationWireFixture,
} from "../../../lib/commcare/__tests__/localizationWireFixture";
import { compileCcz, compileCczParts } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import {
	type TargetFacts,
	targetFactsFromSource,
} from "../../../lib/commcare/targetFacts";
import { DERIVED_WIRE_IDENTITY } from "../../../lib/commcare/wireIdentity";
import { prepareExportBoundaryWithReads } from "../../../lib/export/boundaryValidation";
import { compileLocalArchive } from "../../../lib/export/localArchive";
import { parseLookupRevision } from "../../../lib/lookup/schema";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --conditions=react-server --import tsx proof/native/producers/emit-localization-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of localizationScenarios) {
	const doc = localizationWireFixture(scenario),
		hq = expandDoc(doc),
		zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: NATIVE_RUNTIME_TARGET,
			}),
		);
	const prefix = `locale-${scenario}`;
	writeFileSync(resolve(output, `${prefix}.json`), JSON.stringify(hq));
	for (const entry of zip.getEntries()) {
		const bytes = zip.readFile(entry);
		if (bytes === null) throw new Error(`Missing bytes for ${entry.entryName}`);
		if (entry.entryName === "suite.xml")
			writeFileSync(resolve(output, `${prefix}.suite.xml`), bytes);
		if (entry.entryName === "modules-0/forms-0.xml")
			writeFileSync(resolve(output, `${prefix}.xml`), bytes);
		if (entry.entryName.endsWith("/app_strings.txt"))
			writeFileSync(
				resolve(
					output,
					`${prefix}.${entry.entryName.split("/")[0]}.strings.txt`,
				),
				bytes,
			);
	}
}

/*
 * The archive made for a project space whose stored text would set another
 * string than its key names (`localeSmugglingFixture.ts`), for
 * `LocalizationRuntimeTest` to read through Core's own locale reader: each
 * language directory's `app_strings.txt` as the archive holds it
 * (`kept-text.<dir>.strings.txt`), the compiler's own table for it before it
 * was written (`kept-text.<dir>.table.json`, `compileCczParts`), and the
 * table of the same document's archive with no project space read
 * (`kept-text.<dir>.own.json`), each a list of [key, value] pairs. No
 * `locale-*.json` is written, so the HQ step regenerates nothing of it.
 */
const keptDoc = bilingualSurveyDoc();
const keptFacts = targetFactsFromSource(SMUGGLING_SOURCE, SMUGGLING_READ);
if (keptFacts === null) throw new Error("The kept-text source is an object.");
const keptHq = expandDoc(keptDoc);
function keptTables(
	targetFacts: TargetFacts | null,
): Readonly<Record<string, ReadonlyMap<string, string>>> {
	return compileCczParts(keptHq, keptDoc.appName, keptDoc, {
		runtimeTarget: NATIVE_RUNTIME_TARGET,
		targetFacts,
		adopted: true,
	}).tables;
}
const keptZip = new AdmZip(
	compileCcz(keptHq, keptDoc.appName, keptDoc, {
		runtimeTarget: NATIVE_RUNTIME_TARGET,
		targetFacts: keptFacts,
		adopted: true,
	}),
);
const ownTables = keptTables(null);
for (const [dir, table] of Object.entries(keptTables(keptFacts))) {
	const bytes = keptZip.readFile(`${dir}/app_strings.txt`);
	const own = ownTables[dir];
	if (bytes === null || own === undefined)
		throw new Error(`The kept-text archive holds no ${dir}/app_strings.txt.`);
	writeFileSync(resolve(output, `kept-text.${dir}.strings.txt`), bytes);
	writeFileSync(
		resolve(output, `kept-text.${dir}.table.json`),
		JSON.stringify([...table]),
	);
	writeFileSync(
		resolve(output, `kept-text.${dir}.own.json`),
		JSON.stringify([...own]),
	);
}

/** The browser's and MCP's shared download path for an installation with a single language. */
async function selectedArchive(directory: string) {
	const doc = localizationWireFixture("bilingual");
	if (!doc.localization) throw new Error("Expected a bilingual installation.");
	doc.localization = {
		...doc.localization,
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
	};
	const uuid = testUuid("native selected installation");
	doc.appSettings.installationProfiles = {
		[uuid]: {
			uuid,
			name: "Equipo",
			languages: ["spa"],
			requiresPracticeWorker: false,
		},
	};
	const result = await prepareExportBoundaryWithReads(
		{
			doc,
			mode: "ccz",
			compiledAtSeq: 7,
			access: {
				projectId: "native-install",
				actorUserId: "author",
				role: "editor",
			},
			attachmentTarget: null,
		},
		{
			lookupFixtureData: async (scope) => ({
				projectId: scope.projectId,
				projectRevision: parseLookupRevision("0"),
				definitions: [],
				rowsByTable: new Map(),
			}),
			mediaRows: async () => [],
			mediaManifest: async () => new Map(),
		},
	);
	if (!result.ok) throw new Error(JSON.stringify(result.violations));
	for (const [name, selected] of [
		["named-spanish", uuid],
		["ordinary", undefined],
	] as const) {
		const bytes = compileLocalArchive(
			result.prepared,
			NATIVE_RUNTIME_TARGET,
			DERIVED_WIRE_IDENTITY,
			{
				installationProfileUuid: selected,
				adopted: false,
				earlierHqApps: 0,
				emptyCaseListText: false,
				targetFacts: null,
				keyedCaseIdPrefixes: new Map(),
			},
		);
		writeFileSync(resolve(directory, name + ".ccz"), bytes);
	}
	writeFileSync(
		resolve(directory, "named-spanish.json"),
		JSON.stringify(expandDoc(doc)),
	);
}
selectedArchive(output).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
