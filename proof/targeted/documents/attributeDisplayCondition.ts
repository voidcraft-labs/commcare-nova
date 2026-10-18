/**
 * Defect 2: a form display condition that reads one of the case's own
 * attributes.
 *
 * `targeted-attribute-display-condition` is one case-first menu on
 * `patient`, with no menu display condition so a worker reaches its forms,
 * and two follow-up forms whose display conditions read a reserved case
 * attribute: "Open visit" is shown where the case's `status` is `open`, and
 * "Handed over" where its `owner_id` is `handover`, an owner the lane's case
 * does not have. HQ's `form_filter` parser refuses `#case/@status`, so Nova
 * writes each attribute read expanded through the menu's selected case
 * (`lib/commcare/suite/displayConditions.ts::emitFormDisplayConditionForHq`),
 * the one spelling HQ builds, and the local suite writes the same read.
 *
 * Each form also holds a Hidden Value reading the selected case's name, so
 * the form declares the case database Core evaluates the expectations over:
 * a form holding only a text question declares none.
 *
 * It shows saved forms and not incomplete forms (defect 7 and finding 62),
 * the other way round from `targeted-survey-menu`, so each setting is
 * witnessed at both values.
 *
 * Fixed values: with the patient selected, the expanded read of "Open visit"
 * is true and that of "Handed over" false, on the local archive and on HQ's
 * build.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { restoreXml } from "../restore";

const ID = "targeted-attribute-display-condition";
const uuid = (name: string) => targetedUuid(ID, name);
const PATIENT = "targeted-patient";

/** The case attribute `attribute` of the case the menu's datum selects, as HQ's build reads it. */
function selectedAttribute(attribute: string): string {
	return `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@${attribute}`;
}

/** The form's own display condition, read on `exportName` with the patient selected. */
function conditionHeld(
	id: string,
	form: ReturnType<typeof uuid>,
	command: string,
	condition: string,
	value: "true" | "false",
	exportName: Expectation["export"],
): Expectation {
	return {
		id: `${id}-${exportName}`,
		export: exportName,
		form,
		restore: "restore.xml",
		request: {
			session: { command, data: { case_id: PATIENT } },
			expressions: [condition],
		},
		expect: [{ pointer: "/values/0/value", value }],
	};
}

export function attributeDisplayCondition() {
	const open = uuid("open-visit");
	const handedOver = uuid("handed-over");
	const nameRead = (form: string) =>
		f({
			kind: "hidden",
			uuid: uuid(`${form}-name`),
			id: "patient_name",
			calculate: "#patient/case_name",
		});
	const doc = buildDoc({
		appId: ID,
		appName: "Patient visits",
		appSettings: { showSavedForms: true, showIncompleteForms: false },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "status", label: proseText("Status") },
					{ name: "owner_id", label: proseText("Owner") },
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
						uuid: open,
						name: "Open visit",
						type: "followup",
						displayCondition: eq(prop("patient", "status"), literal("open")),
						fields: [nameRead("open-visit")],
					},
					{
						uuid: handedOver,
						name: "Handed over",
						type: "followup",
						displayCondition: eq(
							prop("patient", "owner_id"),
							literal("handover"),
						),
						fields: [nameRead("handed-over")],
					},
				],
			},
		],
	});
	const openRead = `${selectedAttribute("status")} = 'open'`;
	const handedOverRead = `${selectedAttribute("owner_id")} = 'handover'`;
	return targetedDocument({
		id: ID,
		rows: ["2"],
		doc,
		expected: {
			intent: (["local", "A"] as const).flatMap((exportName) => [
				conditionHeld(
					"open-visit-shown",
					open,
					"m0-f0",
					openRead,
					"true",
					exportName,
				),
				conditionHeld(
					"handed-over-hidden",
					handedOver,
					"m0-f1",
					handedOverRead,
					"false",
					exportName,
				),
			]),
		},
		files: {
			"restore.xml": restoreXml({
				cases: [{ id: PATIENT, type: "patient", name: "Amina" }],
			}),
		},
	});
}
