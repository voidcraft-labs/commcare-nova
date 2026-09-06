import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import {
	caseCaptureFixture,
	caseCaptureScenarios,
} from "../../../lib/commcare/__tests__/caseCaptureFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "../../../lib/commcare/__tests__/caseOperationFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "../../../lib/commcare/__tests__/extensionCaseFixture";
import { usercaseWriteFixture } from "../../../lib/commcare/__tests__/usercaseWriteFixture";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema } from "../../../lib/domain";

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: tsx scripts/fixtures/hq/emit-case-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const [scenario, doc, moduleIndex = 0] of [
	...[...caseCaptureScenarios, "multiple" as const].map(
		(scenario) =>
			[`capture-${scenario}`, caseCaptureFixture(scenario)] as const,
	),
	...extensionScenarios.map(
		(scenario) => [scenario, extensionCaseFixture(scenario)] as const,
	),
	...(["survey", "followup"] as const).map(
		(type) => [`worker-${type}`, usercaseWriteFixture(type)] as const,
	),
	...operationScenarios.map(
		(scenario) =>
			[
				`operation-${scenario}`,
				caseOperationFixture(scenario),
				scenario === "nested" ? 1 : 0,
			] as const,
	),
]) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	const hq = expandDoc(
		doc,
		scenario.startsWith("capture-")
			? {
					attachmentTarget: {
						origin: "https://www.commcarehq.org",
						domain: "demo-project",
					},
				}
			: undefined,
	);
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));

	writeFileSync(resolve(output, `${scenario}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario}.xml`),
		zip.readAsText(`modules-${moduleIndex}/forms-0.xml`),
	);
}
