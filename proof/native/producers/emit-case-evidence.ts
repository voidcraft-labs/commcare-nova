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
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "../../../lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../../../lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema } from "../../../lib/domain";
import { HQ_INSTANT_VECTORS } from "../../../lib/domain/__tests__/hqInstantText.vectors";

import { operationRelevanceDoc } from "../../../lib/preview/engine/__tests__/fixtures/submissionProgram";
import {
	advancedModule,
	rootCaseBlockNames,
} from "../../targeted/documents/advancedModules";
import { caseOrderDocument, caseOrderScenarios } from "./caseOrderScenarios";
import { NATIVE_RUNTIME_TARGET } from "./runtimeTarget";

/** The worker the native runs sign in as (`SuiteFormRun.WORKER`), whose own case the usercase datum finds. */
const WORKER = "worker-id";

/**
 * The cases a run opens a document's forms over (`SuiteFormRun`): one case of each declared type, indexed under
 * `parent` to the one case of its parent type with the type's relationship, and the worker's own case.
 */
function seededCases(doc: BlueprintDoc) {
	return [
		...(doc.caseTypes ?? []).map((type) => ({
			id: `${type.name}-1`,
			type: type.name,
			name: `${type.name} one`,
			indices:
				type.parent_type === undefined
					? []
					: [
							{
								name: "parent",
								type: type.parent_type,
								target: `${type.parent_type}-1`,
								relationship: type.relationship ?? "child",
							},
						],
		})),
		{
			id: "worker-case",
			type: "commcare-user",
			name: "worker",
			properties: { hq_user_id: WORKER },
		},
	];
}

const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node --import tsx proof/native/producers/emit-case-evidence.ts OUTPUT_DIRECTORY",
	);
mkdirSync(output, { recursive: true });
for (const [scenario, doc, moduleIndex = 0] of [
	["operation-relevance", operationRelevanceDoc().doc] as const,
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
	...caseOrderScenarios.map(
		(scenario) =>
			[`operation-${scenario}`, caseOrderDocument(scenario)] as const,
	),
]) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	const hq = expandDoc(
		doc,
		scenario.startsWith("capture-") ||
			(extensionScenarios as readonly string[]).includes(scenario)
			? {
					attachmentTarget: {
						origin: "https://www.commcarehq.org",
						domain: "demo-project",
					},
				}
			: undefined,
	);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: NATIVE_RUNTIME_TARGET,
		}),
	);

	writeFileSync(resolve(output, `${scenario}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${scenario}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${scenario}.xml`),
		zip.readAsText(`modules-${moduleIndex}/forms-0.xml`),
	);
	if ((extensionScenarios as readonly string[]).includes(scenario))
		writeFileSync(
			resolve(output, `${scenario}.cases.json`),
			JSON.stringify(seededCases(doc)),
		);
}

/*
 * The targeted documents the case family's Core classes open whole: every form of each (`<name>.m<i>f<j>.xml`),
 * its suite and its HQ import body, which HQ's step builds again (`proof/native/steps/case_emission.py`).
 * `targeted-advanced-module` is `AdvancedFormRuntimeTest`'s; `targeted-root-case-block-names` the
 * `CaseOperationRuntimeTest` scenario on targeted-root-case-block-names.
 */
for (const [name, document] of [
	["advanced-module", advancedModule()],
	["root-case-block-names", rootCaseBlockNames()],
] as const) {
	const doc = hydratePersistedBlueprint(document.doc);
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, {
			runtimeTarget: NATIVE_RUNTIME_TARGET,
		}),
	);
	writeFileSync(resolve(output, `${name}.json`), JSON.stringify(hq));
	writeFileSync(
		resolve(output, `${name}.suite.xml`),
		zip.readAsText("suite.xml"),
	);
	writeFileSync(
		resolve(output, `${name}.cases.json`),
		JSON.stringify(seededCases(doc)),
	);
	hq.modules.forEach((module, moduleIndex) => {
		module.forms.forEach((_, formIndex) => {
			writeFileSync(
				resolve(output, `${name}.m${moduleIndex}f${formIndex}.xml`),
				zip.readAsText(`modules-${moduleIndex}/forms-${formIndex}.xml`),
			);
		});
	});
}

// StoredInstantRuntimeTest sets each moment as the sequence form's answer and
// clock, in every device zone, and reads the text the case then holds: the
// text CommCare HQ stores for it, written out by hand in the vectors.
writeFileSync(
	resolve(output, "stored-instants.json"),
	`${JSON.stringify({ schemaVersion: 1, vectors: HQ_INSTANT_VECTORS })}\n`,
);
