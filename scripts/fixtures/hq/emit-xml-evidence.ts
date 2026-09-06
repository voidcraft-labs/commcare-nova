import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { buildDoc, f, xp } from "../../../lib/__tests__/docHelpers";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { evaluateCommit } from "../../../lib/commcare/validator/gate";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema, proseText } from "../../../lib/domain";

const output = resolve(process.argv[2] ?? "/tmp/nova-xml-boundary-evidence");
mkdirSync(output, { recursive: true });
const scenarios = [
	{
		name: "unicode",
		text: "é é العربية 汉字 😀 \u007f\u0085\u009f",
		accepted: true,
	},
	{ name: "control", text: "Start \u0001 end", accepted: false },
	{ name: "nul", text: "Start \u0000 end", accepted: false },
	{ name: "surrogate", text: "Start \ud800 end", accepted: false },
	{ name: "noncharacter", text: "Start \uffff end", accepted: false },
];
for (const scenario of scenarios) {
	const doc = buildDoc({
		appName: scenario.accepted ? "Café 雪 😀" : scenario.text,
		modules: [
			{
				name: "Surveys",
				forms: [
					{
						name: "Interview",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "answer",
								label: proseText(scenario.text),
								default_value: xp("'A\tB\nC\rD'"),
							}),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const verdict = evaluateCommit({
		nextDoc: doc,
		lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
	});
	if (verdict.ok !== scenario.accepted)
		throw new Error(`Wrong admission: ${scenario.name}`);
	if (!scenario.accepted) {
		// Preserve the actual source emitted before this repair. The repaired
		// serializer now refuses these values before it can emit malformed XML.
		let refused = false;
		try {
			expandDoc(doc);
		} catch {
			refused = true;
		}
		if (!refused) throw new Error(`Serializer accepted ${scenario.name}`);
		writeFileSync(
			resolve(output, `${scenario.name}.json`),
			readFileSync(
				new URL(`../xml/before-audit-${scenario.name}.json`, import.meta.url),
			),
		);
		continue;
	}
	const hq = expandDoc(doc);
	writeFileSync(resolve(output, `${scenario.name}.json`), JSON.stringify(hq));
	if (scenario.accepted) {
		const archive = new AdmZip(compileCcz(hq, doc.appName, doc));
		writeFileSync(
			resolve(output, `${scenario.name}.xml`),
			archive.readAsText("modules-0/forms-0.xml"),
		);
		writeFileSync(
			resolve(output, `${scenario.name}.ccpr`),
			archive.readAsText("profile.ccpr"),
		);
	}
}
writeFileSync(
	resolve(output, "scenarios.json"),
	JSON.stringify(scenarios, null, 2),
);
console.log(output);
