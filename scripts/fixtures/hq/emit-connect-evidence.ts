import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { connectWireFixtures } from "../../../lib/commcare/__tests__/connectWireFixtures";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";

const output = resolve(process.argv[2] ?? "/tmp/nova-connect-evidence");
mkdirSync(output, { recursive: true });
const scenarios = connectWireFixtures();
for (const { name, doc } of scenarios) {
	const hq = expandDoc(doc);
	writeFileSync(resolve(output, `${name}.json`), JSON.stringify(hq));
	const archive = new AdmZip(compileCcz(hq, doc.appName, doc));
	writeFileSync(
		resolve(output, `${name}.xml`),
		archive.readAsText("modules-0/forms-0.xml"),
	);
}
writeFileSync(
	resolve(output, "scenarios.json"),
	JSON.stringify(
		scenarios.map(({ name }) => ({ name })),
		null,
		2,
	),
);
console.log(output);
