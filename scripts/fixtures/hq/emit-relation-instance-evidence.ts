import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	relationInstanceFixture,
	relationInstanceScenarios,
} from "../../../lib/commcare/__tests__/relationInstanceFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-relation-instance-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of relationInstanceScenarios) {
	const doc = relationInstanceFixture(scenario);
	const hq = expandDoc(doc);
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	const name = `operation-instance-${scenario}`;
	writeFileSync(resolve(output, `${name}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${name}.xml`),
		zip.readAsText("modules-0/forms-0.xml"),
	);
}
