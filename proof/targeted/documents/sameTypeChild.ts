/**
 * A basic child case of its own menu's case type
 * (`targeted-same-type-child`, defect 12's same-type row).
 *
 * HQ's build writes a basic subcase's parent index only where the project
 * space leaves `DONT_INDEX_SAME_CASETYPE` off or the child's type differs
 * from the form's (`corehq/apps/app_manager/xform.py::XForm._create_casexml`,
 * `index_same_casetype`; the toggle is a `StaticToggle`,
 * `corehq/toggles/__init__.py`). A basic menu of patients:
 *
 * - "Add twin", a follow-up whose create of a patient linked to the patient
 *   it works on takes a basic subcase slot. Nova's publish checks the
 *   project space for `same-type-child-links`, which needs the flag off
 *   (`lib/commcare/projectSpaceCompatibility.ts::projectSpaceCompatibilityProbePlan`),
 *   so its verdict lists `DONT_INDEX_SAME_CASETYPE` in `flagsOff`.
 * - "Add sibling", a follow-up whose create of a patient linked the same way
 *   carries a write condition over a text question, which Case Management
 *   cannot state, so a Save to Case block is its simplest placement: the
 *   accepted counterpart, whose index the flag leaves alone.
 *
 * The written edit gives Add twin's write the same condition. Made again
 * over D as its first publish stored it, the basic slot can no longer hold
 * the create, so the edit moves it to the Save to Case block the
 * `same-type-child-links` offer names
 * (`lib/deployment/placementMoves.ts::placementMoveOffer`), and D′'s verdict
 * requires the flag off no longer.
 *
 * Fixed values: each form, opened on the patient `targeted-amina`, holds the
 * new patient's name as answered.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Expression,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-same-type-child";
export const sameTypeChildUuid = (name: string) => targetedUuid(ID, name);
const uuid = sameTypeChildUuid;

/** A condition written as form text, which `buildDoc` parses in its slot. */
function condition(text: string): Expression {
	return text as unknown as Expression;
}

/**
 * The create of a patient linked to the patient the form works on, its
 * relation written from the form's `relation` question, under `when` where
 * one is given.
 */
function patientChild(
	key: string,
	form: string,
	when: string | undefined,
): CaseOperation {
	const read = (question: string) =>
		term(formField(uuid(`${form}-${question}`)));
	return {
		uuid: uuid(key),
		id: key,
		action: "create",
		caseType: "patient",
		target: { kind: "new" },
		name: read("name"),
		writes: [
			{
				property: "relation",
				value: read("relation"),
				...(when !== undefined && { condition: condition(when) }),
			},
		],
		links: [
			{
				identifier: "parent",
				targetType: "patient",
				target: { kind: "session" },
				relationship: "child",
			},
		],
	} as CaseOperation;
}

/** A follow-up form's questions: the new patient's name, its relation, and whether it is confirmed. */
function questions(form: string) {
	return [
		f({
			kind: "text",
			uuid: uuid(`${form}-name`),
			id: "name",
			label: proseText("Name"),
		}),
		f({
			kind: "text",
			uuid: uuid(`${form}-relation`),
			id: "relation",
			label: proseText("Relation"),
		}),
		f({
			kind: "text",
			uuid: uuid(`${form}-confirmed`),
			id: "confirmed",
			label: proseText("Confirmed"),
		}),
	];
}

const CONFIRMED = "#form/confirmed = 'yes'";

/**
 * The app before the edit (`edited: false`), Add twin's create in a basic
 * subcase slot, and after it, Add twin's write under the condition Add
 * sibling's carries.
 */
export function sameTypeChildApp(edited: boolean): BlueprintDoc {
	const twin = uuid("twin-form");
	const sibling = uuid("sibling-form");
	return buildDoc(
		{
			appId: ID,
			appName: "Patient families",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "relation",
							label: proseText("Relation"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					uuid: uuid("patients"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf([
						plainColumn(uuid("name-column"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: twin,
							name: "Add twin",
							type: "followup",
							fields: questions("twin"),
						},
						{
							uuid: sibling,
							name: "Add sibling",
							type: "followup",
							fields: questions("sibling"),
						},
					],
				},
			],
		},
		(built) => {
			built.forms[twin].caseOperations = [
				patientChild("twin", "twin", edited ? CONFIRMED : undefined),
			];
			built.forms[sibling].caseOperations = [
				patientChild("sibling", "sibling", CONFIRMED),
			];
		},
	);
}

export function sameTypeChild() {
	const session = (command: string) => ({
		command,
		caseId: "targeted-amina",
	});
	return targetedDocument({
		id: ID,
		rows: ["12, same-type child"],
		doc: sameTypeChildApp(false),
		edit: sameTypeChildApp(true),
		expected: {
			intent: [
				answerHeld(
					"twin-name",
					uuid("twin-form"),
					"/data/name",
					"Bola",
					"local",
					session("m0-f0"),
				),
				answerHeld(
					"sibling-name",
					uuid("sibling-form"),
					"/data/name",
					"Chidi",
					"A",
					session("m0-f1"),
				),
			],
		},
	});
}
