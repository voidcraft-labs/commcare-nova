import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { connectWireFixtures } from "../../../lib/commcare/__tests__/connectWireFixtures";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

/**
 * Each form of a scenario's one menu, by the stem its files take: the first
 * form under the scenario's name, and a deliver scenario's second form, which
 * holds the task, under `<scenario>.task`.
 */
const FORM_STEMS = ["", ".task"] as const;

const outputArgument = process.argv[2];
if (!outputArgument)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-connect-evidence.ts OUTPUT_DIRECTORY",
	);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const scenarios = connectWireFixtures().map(({ name, doc }) => {
	const hq = expandDoc(doc);
	const forms = hq.modules[0]?.forms.length ?? 0;
	if (hq.modules.length !== 1 || forms < 1 || forms > FORM_STEMS.length)
		throw new Error(
			`The Connect scenario ${name} has ${hq.modules.length} menus and ${forms} forms in its first; the native family reads one menu of one form, or of a deliver form and its task's form.`,
		);
	writeFileSync(resolve(output, `${name}.json`), JSON.stringify(hq));
	const archive = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: NATIVE_RUNTIME_TARGET,
		}),
	);
	const stems = FORM_STEMS.slice(0, forms).map((suffix) => `${name}${suffix}`);
	stems.forEach((stem, index) => {
		writeFileSync(
			resolve(output, `${stem}.xml`),
			archive.readAsText(`modules-0/forms-${index}.xml`),
		);
	});
	return { name, forms: stems };
});
writeFileSync(
	resolve(output, "scenarios.json"),
	JSON.stringify(scenarios, null, 2),
);
console.log(output);
