import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	tileFixture,
	tileScenarios,
} from "../../../lib/commcare/__tests__/tileFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema } from "../../../lib/domain";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-tile-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const scenario of tileScenarios) {
	const doc = tileFixture(scenario);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	const hq = expandDoc(doc);
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	writeFileSync(resolve(output, `${scenario}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
}
