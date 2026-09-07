import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	caseListEmissionFixture,
	caseListEmissionScenarios,
} from "../../../lib/commcare/__tests__/caseListEmissionFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema } from "../../../lib/domain";

const output = process.argv[2];
if (!output) throw new Error("Expected evidence output directory");
mkdirSync(output, { recursive: true });
for (const scenario of caseListEmissionScenarios) {
	const { doc, assets } = caseListEmissionFixture(scenario);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify({ scenario, findings }));
	const runtimeTarget = {
		server: "production",
		domain: "nova-search-evidence",
		appId: "search-evidence",
	} as const;
	const options = { assets, runtimeTarget };
	const hq = expandDoc(doc, options);
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc, options));
	writeFileSync(resolve(output, `${scenario}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario}.properties`),
		zip.readAsText("default/app_strings.txt"),
	);
}
