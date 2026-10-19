import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	csqlScenarios,
	scenarioRecord,
} from "../../../lib/commcare/__tests__/csqlCompositionFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-csql-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
const runtimeTarget = {
	server: "production",
	domain: "nova-search-evidence",
	appId: "search-evidence",
} as const;
const records: string[] = [];
for (const scenario of csqlScenarios) {
	const doc = scenario.doc();
	const hq = expandDoc(doc, { runtimeTarget });
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc, { runtimeTarget }));
	writeFileSync(resolve(output, `${scenario.id}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario.id}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario.id}.strings.txt`),
		zip.readAsText("default/app_strings.txt"),
	);
	records.push(JSON.stringify(scenarioRecord(scenario)));
}
// One line per scenario: its cases, searches and expected ids. Not `.json`,
// which the family's HQ step reads as app sources.
writeFileSync(resolve(output, "scenarios.jsonl"), `${records.join("\n")}\n`);
