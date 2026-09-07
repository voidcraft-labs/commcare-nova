import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	containerScenarios,
	containerWireFixture,
} from "../../../lib/commcare/__tests__/containerWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error("Usage: emit-container-evidence.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
for (const scenario of containerScenarios) {
	const doc = containerWireFixture(scenario);
	const hq = expandDoc(doc);
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	const form = Object.values(hq._attachments)[0];
	if (typeof form !== "string") throw new Error("Missing XForm");
	const local = zip
		.getEntries()
		.filter(
			(e) => e.entryName.endsWith(".xml") && e.entryName.startsWith("modules-"),
		);
	if (local.length !== 1)
		throw new Error(JSON.stringify(zip.getEntries().map((e) => e.entryName)));
	writeFileSync(
		resolve(output, `container-${scenario}.xml`),
		zip.readAsText(local[0]),
	);
	writeFileSync(resolve(output, `container-${scenario}.source.xml`), form);
	writeFileSync(
		resolve(output, `container-${scenario}.json`),
		JSON.stringify(hq),
	);
}
