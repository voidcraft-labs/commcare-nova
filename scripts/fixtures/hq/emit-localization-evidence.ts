import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	localizationScenarios,
	localizationWireFixture,
} from "../../../lib/commcare/__tests__/localizationWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output)
	throw new Error("Usage: emit-localization-evidence.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
for (const scenario of localizationScenarios) {
	const doc = localizationWireFixture(scenario),
		hq = expandDoc(doc),
		zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	const prefix = `locale-${scenario}`;
	writeFileSync(resolve(output, `${prefix}.json`), JSON.stringify(hq));
	for (const entry of zip.getEntries()) {
		const bytes = zip.readFile(entry);
		if (bytes === null) throw new Error(`Missing bytes for ${entry.entryName}`);
		if (entry.entryName === "suite.xml")
			writeFileSync(resolve(output, `${prefix}.suite.xml`), bytes);
		if (entry.entryName === "modules-0/forms-0.xml")
			writeFileSync(resolve(output, `${prefix}.xml`), bytes);
		if (entry.entryName.endsWith("/app_strings.txt"))
			writeFileSync(
				resolve(
					output,
					`${prefix}.${entry.entryName.split("/")[0]}.strings.txt`,
				),
				bytes,
			);
	}
}
