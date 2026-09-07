import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { buildDoc, f, xp } from "../../../lib/__tests__/docHelpers";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { FUNCTION_REGISTRY } from "../../../lib/commcare/validator/functionRegistry";
import { runValidation } from "../../../lib/commcare/validator/runner";
import {
	nativeCoercionCases,
	nativePathCases,
	normalizationCases,
	refusedNativePaths,
} from "../../../lib/commcare/xpath/__tests__/nativeXPathCorpus";
import { analyzeXPathCompatibility } from "../../../lib/commcare/xpath/compatibility";
import { JAVAROSA_NATIVE_FUNCTIONS } from "../../../lib/commcare/xpath/functionCapabilities";
import { lowerXPathForJavaRosa } from "../../../lib/commcare/xpath/javaRosaLowering";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema, proseText } from "../../../lib/domain";

const output = resolve(process.argv[2] ?? "/tmp/nova-xpath-evidence");
mkdirSync(output, { recursive: true });
const doc = buildDoc({
	appName: "XPath proof",
	modules: [
		{
			name: "Checks",
			forms: [
				{
					name: "XPath proof",
					type: "survey",
					fields: [
						f({
							kind: "text",
							id: "answer",
							label: proseText("Answer"),
							default_value: xp("'  alpha\tbeta\r\ngamma  '"),
						}),
						f({
							kind: "hidden",
							id: "normalized",
							calculate: "normalize-space(#form/answer)",
						}),
						f({
							kind: "group",
							id: "group",
							label: proseText("Group"),
							children: [
								f({
									kind: "text",
									id: "value",
									label: proseText("Value"),
									default_value: xp("'nested'"),
								}),
								f({ kind: "text", id: "other", label: proseText("Other") }),
							],
						}),
					],
				},
			],
		},
	],
});
blueprintDocSchema.parse(toPersistableDoc(doc));
const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
if (findings.length) throw new Error(JSON.stringify(findings));
const hq = expandDoc(doc);
const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
writeFileSync(
	resolve(output, "xpath-context.xml"),
	zip.readAsText("modules-0/forms-0.xml"),
);
const encoded = (value: string) => Buffer.from(value).toString("base64");
const rows = [
	...normalizationCases,
	...nativePathCases,
	...nativeCoercionCases,
].map(({ name, source, expected }) => {
	const findings = analyzeXPathCompatibility(source, "wire-form");
	if (findings.length) throw new Error(`${name}: ${JSON.stringify(findings)}`);
	return [
		name,
		typeof expected,
		encoded(lowerXPathForJavaRosa(source)),
		encoded(String(expected)),
	].join("\t");
});
for (const source of refusedNativePaths) {
	if (!analyzeXPathCompatibility(source, "wire-form").length)
		throw new Error(`Admitted forbidden path ${source}`);
	rows.push(["rejected path", "reject", encoded(source), ""].join("\t"));
}
writeFileSync(resolve(output, "xpath-corpus.tsv"), `${rows.join("\n")}\n`);
writeFileSync(
	resolve(output, "native-functions.txt"),
	`${[...JAVAROSA_NATIVE_FUNCTIONS].sort().join("\n")}\n`,
);
console.log(output);

const signatures = [];
for (const [name, spec] of FUNCTION_REGISTRY) {
	if (!JAVAROSA_NATIVE_FUNCTIONS.has(name)) continue;
	for (let count = 0; count <= 10; count++) {
		const accepted =
			count >= spec.minArgs &&
			(spec.maxArgs === -1 || count <= spec.maxArgs) &&
			spec.validate?.(count) === undefined;
		signatures.push(
			`${encoded(`${name}(${Array.from({ length: count }, () => "'x'").join(", ")})`)}	${accepted}`,
		);
	}
}
writeFileSync(
	resolve(output, "native-signatures.tsv"),
	`${signatures.join("\n")}\n`,
);
