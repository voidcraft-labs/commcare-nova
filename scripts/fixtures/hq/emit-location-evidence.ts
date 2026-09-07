import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import {
	LOCATION_SCENARIOS,
	locationOwnerFixture,
} from "../../../lib/commcare/locations/__tests__/locationOwnerFixture";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-location-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of LOCATION_SCENARIOS) {
	const doc = locationOwnerFixture(scenario),
		hq = expandDoc(doc),
		zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	writeFileSync(
		resolve(output, `location-${scenario}.json`),
		JSON.stringify(hq),
	);
	writeFileSync(
		resolve(output, `location-${scenario}.xml`),
		zip.readAsText("modules-0/forms-0.xml"),
	);
}
