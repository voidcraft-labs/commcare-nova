/**
 * Defect 28, load-time values: a default that reads an answer the form
 * preloads from its case.
 *
 * A follow-up form opens each answer that writes its own case's property
 * showing the case's value (`lib/domain/casePreload.ts::
 * writerPreloadsFromLoadedCase`), which Nova sends HQ as the form's basic
 * `case_preload` (`lib/commcare/deriveCaseConfig.ts`). HQ's build loads it
 * after every other load-time `setvalue` of the form
 * (`app_manager/xform.py::XForm.add_case_preloads`), so a default later in
 * the form that reads the preloaded answer reads it blank there. The manifest
 * check refuses that shape
 * (`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`,
 * `load-changes-values`), which otherwise only the fuzz sample shows.
 *
 * Fixed values: opened on the patient Amina, the weight a worker enters is
 * the weight the form holds.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-load-time-values";
const uuid = (name: string) => targetedUuid(ID, name);

export function loadTimeValues() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Patient weights",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "weight", label: proseText("Weight"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Weigh",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("weight"),
								id: "weight",
								label: proseText("Weight"),
								caseWrite: { caseType: "patient", property: "weight" },
							}),
							f({
								kind: "text",
								uuid: uuid("weight-note"),
								id: "weight_note",
								label: proseText("Note"),
								default_value: "concat('was ', #form/weight)",
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-amina",
				type: "patient",
				name: "Amina",
				properties: { weight: "64" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["28, load-time values"],
		doc,
		expected: {
			intent: [
				{
					id: "weight-held",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0", data: { case_id: "targeted-amina" } },
						answers: [{ path: "/data/weight", value: "70" }],
						expressions: ["/data/weight"],
					},
					expect: [
						{ pointer: "/answers/0/result", value: "ok" },
						{ pointer: "/values/0/value", value: "70" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
