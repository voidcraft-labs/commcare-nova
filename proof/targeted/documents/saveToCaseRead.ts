/**
 * Defect 3's last clause: a form that reads a case property only a Save to
 * Case block writes.
 *
 * HQ's case schema learns a Save to Case block's properties only from
 * `case_references_data.save`, which Nova leaves empty
 * (`models/forms.py::get_save_references`), so the property is in no list
 * HQ's form builder is given (`app_schemas/casedb_schema.py`), and a
 * question that reads it as `#case/<property>` is an unknown question to
 * Vellum (`src/logic.js::_addReferences`), which asks about reference errors
 * on every save.
 *
 * Two forms of one menu. "Assess" holds one case operation, an update of the
 * selected patient that writes `risk_level` from an answer: the only writer
 * of that property, and a Save to Case block on the wire. It also writes
 * `visit_count` from an ordinary field, which HQ's own case management
 * carries. "Review" validates one answer against each property. So HQ's
 * form builder warns about the read of `risk_level` and not about the read
 * of `visit_count`, the control inside the document: the two reads differ
 * only in who writes the property.
 *
 * Fixed values: a patient at risk level "high" refuses a review that says
 * "low" and takes one that says "high".
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { formField, term } from "@/lib/domain/predicate";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-save-to-case-read";
const uuid = (name: string) => targetedUuid(ID, name);

export function saveToCaseRead() {
	const assess = uuid("assess");
	const review = uuid("review");
	const level = uuid("level");
	const built = buildDoc({
		appId: ID,
		appName: "Risk review",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "risk_level",
						label: proseText("Risk level"),
						data_type: "text",
					},
					{
						name: "visit_count",
						label: proseText("Visits"),
						data_type: "text",
					},
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
						uuid: assess,
						name: "Assess",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: level,
								id: "level",
								label: proseText("Risk level"),
							}),
							f({
								kind: "text",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Visits so far"),
								caseWrite: { caseType: "patient", property: "visit_count" },
							}),
						],
					},
					{
						uuid: review,
						name: "Review",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("agreed"),
								id: "agreed",
								label: proseText("Risk level agreed"),
								validate: ". = #patient/risk_level",
								validate_msg: "This is not the level the assessment gave.",
							}),
							f({
								kind: "text",
								uuid: uuid("counted"),
								id: "counted",
								label: proseText("Visits counted"),
								validate: ". = #patient/visit_count",
								validate_msg: "This is not the count the assessment gave.",
							}),
						],
					},
				],
			},
		],
	});
	const operation: CaseOperation = {
		uuid: uuid("operation"),
		id: "set_risk",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "risk_level", value: term(formField(level)) }],
	};
	const doc: BlueprintDoc = {
		...built,
		forms: {
			...built.forms,
			[assess]: { ...built.forms[assess], caseOperations: [operation] },
		},
	};
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-amina",
				type: "patient",
				name: "Amina",
				properties: { risk_level: "high", visit_count: "3" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["3, a read of a property only a Save to Case block writes"],
		doc,
		expected: {
			intent: [
				{
					id: "review-refuses-another-level",
					export: "local",
					form: review,
					restore: "restore.xml",
					request: {
						session: {
							command: "m0-f1",
							data: { case_id: "targeted-amina" },
						},
						constraintChecks: [
							{ path: "/data/agreed", value: "low" },
							{ path: "/data/agreed", value: "high" },
							{ path: "/data/counted", value: "3" },
						],
					},
					expect: [
						{ pointer: "/constraints/0/result", value: "constraint" },
						{ pointer: "/constraints/1/result", value: "ok" },
						{ pointer: "/constraints/2/result", value: "ok" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
