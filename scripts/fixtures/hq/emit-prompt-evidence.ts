import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	promptLookupFixtures,
	promptLookupNaming,
	promptScenarios,
	searchPromptFixture,
} from "../../../lib/commcare/__tests__/searchPromptFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-prompt-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of promptScenarios) {
	const doc = searchPromptFixture(scenario);
	const runtimeTarget = {
		server: "production",
		domain: "nova-search-evidence",
		appId: "search-evidence",
	} as const;
	const hq = expandDoc(doc, {
		runtimeTarget,
		lookupNaming: promptLookupNaming,
	});
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget,
			lookup: { naming: promptLookupNaming, fixtures: promptLookupFixtures },
		}),
	);
	writeFileSync(resolve(output, `${scenario}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario}.strings.txt`),
		zip.readAsText("default/app_strings.txt"),
	);
}
writeFileSync(
	resolve(output, "regions.fixture.xml"),
	promptLookupFixtures.fixtures[0].xml,
);
