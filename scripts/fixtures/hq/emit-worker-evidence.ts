import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	workerSlugs,
	workerWireFixture,
} from "../../../lib/commcare/__tests__/workerWireFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = process.argv[2];
if (!output) throw new Error("Usage: emit-worker-evidence.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
for (const slug of workerSlugs) {
	const { doc } = workerWireFixture(slug),
		hq = expandDoc(doc),
		zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	writeFileSync(resolve(output, `worker-${slug}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `worker-${slug}.xml`),
		zip.readAsText("modules-0/forms-0.xml"),
	);
	writeFileSync(
		resolve(output, `worker-${slug}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
}
