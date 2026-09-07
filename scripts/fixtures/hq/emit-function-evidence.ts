import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	csqlArgumentFixture,
	csqlFunctionFixture,
	functionLookupFixtures,
	functionLookupNaming,
} from "../../../lib/commcare/__tests__/csqlFunctionFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-function-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of ["nested-lookup", "function-arguments"]) {
	const doc =
		scenario === "nested-lookup"
			? csqlFunctionFixture()
			: csqlArgumentFixture();
	const runtimeTarget = {
		server: "production",
		domain: "nova-search-evidence",
		appId: "search-evidence",
	} as const;
	const hq = expandDoc(doc, {
		runtimeTarget,
		lookupNaming: functionLookupNaming,
	});
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget,
			lookup: {
				naming: functionLookupNaming,
				fixtures: functionLookupFixtures,
			},
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
	resolve(output, "search-values.fixture.xml"),
	functionLookupFixtures.fixtures[0].xml,
);
