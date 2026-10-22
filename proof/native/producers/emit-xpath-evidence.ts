import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
import { buildDoc, f } from "../../../lib/__tests__/docHelpers";
import { compileCcz } from "../../../lib/commcare/compiler";
import { expandDoc } from "../../../lib/commcare/expander";
import { runValidation } from "../../../lib/commcare/validator/runner";
import { formExpressionEmission } from "../../../lib/commcare/xform/formExpressions";
import {
	blankValueCases,
	nativeCoercionCases,
	nativeFunctionCases,
	nativePathCases,
	normalizationCases,
	rawCorePathControls,
	refusedNativePaths,
} from "../../../lib/commcare/xpath/__tests__/nativeXPathCorpus";
import { parseFormExpression } from "../../../lib/commcare/xpath/expressionAst";
import { JAVAROSA_NATIVE_FUNCTIONS } from "../../../lib/commcare/xpath/functionCapabilities";
import { serializeWire } from "../../../lib/commcare/xpath/wire/serialize";
import { toPersistableDoc } from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { blueprintDocSchema, proseText } from "../../../lib/domain";
import {
	FUNCTION_REGISTRY,
	functionArityIssue,
} from "../../../lib/domain/expressionFunctions";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

const outputArgument = process.argv[2];
if (!outputArgument)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-xpath-evidence.ts OUTPUT_DIRECTORY",
	);
const output = resolve(outputArgument);
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
							default_value: "'  alpha\tbeta\r\ngamma  '",
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
									default_value: "'nested'",
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
const zip = new AdmZip(
	compileCcz(hq, doc.appName, doc, {
		runtimeTarget: NATIVE_RUNTIME_TARGET,
	}),
);
writeFileSync(
	resolve(output, "xpath-context.xml"),
	zip.readAsText("modules-0/forms-0.xml"),
);
const encoded = (value: string) => Buffer.from(value).toString("base64");
const normalized = Object.values(doc.fields).find(
	(field) => field.id === "normalized",
);
const formUuid = doc.formOrder[doc.moduleOrder[0]]?.[0];
if (normalized === undefined || formUuid === undefined)
	throw new Error("The native XPath fixture has no calculate slot.");
const slot = {
	entity: "field",
	uuid: normalized.uuid,
	slot: "calculate",
} as const;
const scope = { doc, slot, lookup: new Map() };
const emission = formExpressionEmission(doc, formUuid, undefined, {});
function canonical(source: string): string {
	const parsed = parseFormExpression(source, scope);
	if (!parsed.ok || parsed.expression === undefined)
		throw new Error(
			`Cannot bind native XPath ${source}: ${JSON.stringify(parsed)}`,
		);
	return serializeWire(emission.lower(parsed.expression, slot), {
		target: "xform",
		constraint: false,
	}).text;
}
const rows = [
	...blankValueCases,
	...normalizationCases,
	...nativePathCases,
	...nativeCoercionCases,
].map(({ name, source, expected }) => {
	return [
		name,
		typeof expected,
		encoded(canonical(source)),
		encoded(String(expected)),
	].join("\t");
});
for (const source of refusedNativePaths) {
	if (parseFormExpression(source, scope).ok)
		throw new Error(`Admitted forbidden path ${source}`);
	rows.push(["rejected path", "reject", encoded(source), ""].join("\t"));
}
writeFileSync(resolve(output, "xpath-corpus.tsv"), `${rows.join("\n")}\n`);
const controls = rawCorePathControls.map(({ name, source, expected }) => {
	if (parseFormExpression(source, scope).ok)
		throw new Error(`A raw Core-only control became authorable: ${source}`);
	return [
		name,
		typeof expected,
		encoded(source),
		encoded(String(expected)),
	].join("\t");
});
writeFileSync(
	resolve(output, "raw-core-path-controls.tsv"),
	`${controls.join("\n")}\n`,
);
const functionNames = Object.keys(nativeFunctionCases).sort();
if (
	JSON.stringify(functionNames) !==
	JSON.stringify([...JAVAROSA_NATIVE_FUNCTIONS].sort())
)
	throw new Error(
		"The native function mapping must name every claimed function exactly once.",
	);
writeFileSync(
	resolve(output, "native-functions.tsv"),
	`${Object.entries(nativeFunctionCases)
		.map(([name, source]) =>
			[name, encoded(source), encoded(canonical(source))].join("\t"),
		)
		.join("\n")}\n`,
);

const signatures = [];
for (const [name, spec] of FUNCTION_REGISTRY) {
	if (!JAVAROSA_NATIVE_FUNCTIONS.has(name)) continue;
	for (let count = 0; count <= 10; count++) {
		const accepted = functionArityIssue(name, count, spec) === undefined;
		const source = `${name}(${Array.from({ length: count }, () => "'x'").join(", ")})`;
		const parsed = parseFormExpression(source, scope);
		if (parsed.ok !== accepted)
			throw new Error(
				`The form parser disagrees with declared arity: ${source}`,
			);
		signatures.push(
			[
				encoded(source),
				String(accepted),
				accepted ? encoded(canonical(source)) : "",
			].join("\t"),
		);
	}
}
writeFileSync(
	resolve(output, "native-signatures.tsv"),
	`${signatures.join("\n")}\n`,
);
console.log(output);
