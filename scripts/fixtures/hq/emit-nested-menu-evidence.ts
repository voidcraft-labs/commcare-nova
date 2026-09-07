import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	nestedMenuScenarios,
	nestedMenuWireFixture,
} from "../../../lib/commcare/__tests__/nestedMenuWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { hqNestedSelectionFindings } from "../../../lib/commcare/hqNestedSelection";

const output = process.argv[2];
if (!output)
	throw new Error("Usage: emit-nested-menu-evidence.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
const targetRefusals: Record<string, unknown> = {};
for (const scenario of nestedMenuScenarios) {
	const doc = nestedMenuWireFixture(scenario),
		hq = expandDoc(doc),
		zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: {
					server: "production",
					domain: "test-domain",
					appId: "nested-menu-evidence",
				},
			}),
		);
	// The two refused HQ projections are emitted deliberately as a native
	// counterexample corpus, never as prepared export artifacts.
	targetRefusals[scenario] = hqNestedSelectionFindings(doc, "hq-json");
	writeFileSync(
		resolve(output, `nested-menu-${scenario}.json`),
		JSON.stringify(hq),
	);
	writeFileSync(
		resolve(output, `nested-menu-${scenario}.xml`),
		zip.readAsText(`modules-1/forms-0.xml`),
	);
	writeFileSync(
		resolve(output, `nested-menu-${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
}
writeFileSync(
	resolve(output, "hq-nested-target-refusals.json"),
	JSON.stringify(targetRefusals, null, 2),
);
