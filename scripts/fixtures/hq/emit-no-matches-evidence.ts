import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	noMatchesWireFixture,
	noMatchesWireScenarios,
} from "../../../lib/commcare/__tests__/noMatchesWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error("Usage: emit-no-matches-evidence.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
for (const scenario of noMatchesWireScenarios) {
	const doc = noMatchesWireFixture(scenario),
		hq = expandDoc(doc),
		zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: {
					server: "production",
					domain: "test-domain",
					appId: "no-matches-evidence",
				},
			}),
		);
	writeFileSync(
		resolve(output, `no-matches-${scenario}.json`),
		JSON.stringify(hq),
	);
	writeFileSync(
		resolve(output, `no-matches-${scenario}.xml`),
		zip.readAsText(`modules-${hq.modules.length - 1}/forms-0.xml`),
	);
	writeFileSync(
		resolve(output, `no-matches-${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
}
