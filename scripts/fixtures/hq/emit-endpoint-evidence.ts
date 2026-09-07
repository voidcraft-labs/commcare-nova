import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	endpointScenarios,
	endpointWireFixture,
} from "../../../lib/commcare/__tests__/endpointWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error("Usage: emit-endpoint-evidence.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
for (const scenario of endpointScenarios) {
	const doc = endpointWireFixture(scenario),
		hq = expandDoc(doc),
		zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: {
					server: "production",
					domain: "test-domain",
					appId: "endpoint-evidence",
				},
			}),
		);
	writeFileSync(
		resolve(output, `endpoint-${scenario}.json`),
		JSON.stringify(hq),
	);
	writeFileSync(
		resolve(output, `endpoint-${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
}
