/**
 * Defect 28, load-time values: a default that reads an answer the form
 * opens with its case's value.
 *
 * A question opens showing its case's current value only where its starting
 * value says so: the weight writer's default is the read of the patient's
 * weight (`lib/domain/casePreload.ts::fieldPreload`), which Nova writes as
 * the form builder's own default, a setvalue at the question's place in the
 * form, and never as a `case_preload` (HQ's build would load that after
 * every other load-time `setvalue` of the form,
 * `app_manager/xform.py::XForm.add_case_preloads`, so a default later in the
 * form that read the answer read it blank). The note's default, later in the
 * form, reads the weight, so it opens holding the case's weight. The export
 * holds no `case_preload`, the refused shape of
 * `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`
 * (`load-changes-values`), which the retained control
 * `targeted-load-time-values` still shows.
 *
 * Beside them, a Hidden Value with neither a calculate nor a default: a data
 * node with a bare bind and no `setvalue`, which HQ's form builder keeps as
 * it is and Core opens blank.
 *
 * Fixed values: opened on the patient Amina, whose weight is 64, the note
 * opens as `was 64`, and the weight a worker enters is the weight the form
 * holds.
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
								default_value: "#patient/weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
							f({
								kind: "text",
								uuid: uuid("weight-note"),
								id: "weight_note",
								label: proseText("Note"),
								default_value: "concat('was ', #form/weight)",
							}),
							f({ kind: "hidden", uuid: uuid("bare"), id: "bare" }),
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
					id: "note-reads-case",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0", data: { case_id: "targeted-amina" } },
						expressions: ["/data/weight", "/data/weight_note"],
					},
					expect: [
						{ pointer: "/values/0/value", value: "64" },
						{ pointer: "/values/1/value", value: "was 64" },
					],
				},
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
