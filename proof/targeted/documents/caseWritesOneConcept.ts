/**
 * Case writes as one concept: every case change a form makes is one of its
 * case operations, the form's own case first, each kept where CommCare HQ
 * keeps it (`lib/commcare/placement.ts::planPlacements`).
 *
 * A basic menu of patients (`patient`, whose parent is a `household`):
 *
 * - "Register patient": its own case saves three answers (the name, the age
 *   and the village), is created only when the consent select says `yes`
 *   (`openCondition`) and is closed at once when the outcome select says
 *   `moved` (`closeCondition`, a `choice` of the select). It creates a
 *   contact at the form's root, HQ's basic subcase `subcase_0`, and a dose in
 *   each row of the repeat `doses` whose `given` select says `yes`, the
 *   repeat's one basic subcase, written at the row's `case`; and it saves
 *   the village to the worker's own record. All of it is Case Management's
 *   (`open_case`, `update_case`, `close_case`, `subcases`, `usercase_update`).
 * - "Check patient": its own case saves the weight, which opens with the
 *   patient's weight (the explicit preload, a default reading the case), a
 *   note, which opens blank, the household's district through the patient's
 *   `parent` index (an update key `parent/district`), and the risk only when
 *   the worker changed it (`update_mode: edit`, which the project space's
 *   `SAVE_ONLY_EDITED_FORM_FIELDS` makes HQ's build compare,
 *   `corehq/apps/app_manager/xform.py::XFormCaseBlock.add_case_updates`).
 * - "Score patient": its own case saves a computed score, which Case
 *   Management cannot state, so that change is a Save to Case block, and
 *   this form alone needs Save to Case.
 * - "Discharge": a close form whose close condition compares a static
 *   select with one of its choices, which Case Management states.
 *
 * Written D′ renames the value of the outcome's choice `moved`, so the
 * registration's close condition, which holds the choice, prints the new
 * value (proof 5).
 *
 * Fixed values: "Check patient" opened on the patient Amina, whose weight is
 * 64, opens with the weight 64 and a blank note.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Expression,
	plainColumn,
	proseText,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { arith, formField, literal, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-case-writes-one-concept";
const uuid = (name: string) => targetedUuid(ID, name);

/** A condition written as form text, which `buildDoc` parses in its slot. */
function condition(text: string): Expression {
	return text as unknown as Expression;
}

function patients(movedValue: string): BlueprintDoc {
	const register = uuid("register");
	const check = uuid("check");
	const score = uuid("score");
	const registerOwn = uuid("register-own");
	const workerVillage = uuid("worker-last-village");
	const read = (key: string) => term(formField(uuid(key)));
	const text = (key: string, label: string) =>
		f({
			kind: "text",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
		});
	const select = (key: string, label: string, values: readonly string[]) =>
		f({
			kind: "single_select",
			uuid: uuid(key),
			id: key.replaceAll("-", "_"),
			label: proseText(label),
			options: values.map((value) => ({
				uuid: uuid(`${key}-${value === movedValue ? "moved" : value}`),
				value,
				// The choice keeps its label when D′ renames its value.
				label: proseText(value === movedValue ? "moved" : value),
			})),
		});
	const toPatient = [
		{
			identifier: "parent",
			targetType: "patient",
			target: { kind: "op", opUuid: registerOwn } as const,
			relationship: "child" as const,
		},
	];
	const registerOperations: CaseOperation[] = [
		{
			uuid: registerOwn,
			id: "patient",
			action: "own",
			name: read("patient-name"),
			writes: [
				{ property: "age", value: read("age") },
				{ property: "village", value: read("village") },
			],
		},
		{
			// A child at the form's root: HQ's basic subcase `subcase_0`.
			uuid: uuid("add-contact"),
			id: "contact",
			action: "create",
			caseType: "contact",
			target: { kind: "new" },
			name: read("contact-name"),
			links: toPatient,
		},
		{
			uuid: uuid("worker-record"),
			id: "commcare_user",
			action: "update",
			caseType: USERCASE_CASE_TYPE,
			target: { kind: "worker-record" },
			writes: [{ property: "last_village", value: read("village") }],
		},
		{
			// A child in each row whose dose was given: the repeat's one basic
			// subcase, whose condition reads a select in its own row.
			uuid: uuid("add-dose"),
			id: "dose",
			action: "create",
			caseType: "dose",
			target: { kind: "new" },
			forEach: { repeat: uuid("doses") },
			condition: condition("#form/doses/given = 'yes'"),
			name: read("dose-name"),
			links: toPatient,
		},
	];
	const checkOperations: CaseOperation[] = [
		{
			uuid: uuid("check-own"),
			id: "patient",
			action: "own",
			writes: [
				{ property: "weight", value: read("weight") },
				{ property: "note", value: read("note") },
				{
					property: "district",
					value: read("district"),
					via: [{ identifier: "parent" }],
				},
				{ property: "risk", value: read("risk"), onlyIfChanged: true },
			],
		},
	];
	const scoreOperations: CaseOperation[] = [
		{
			uuid: uuid("score-own"),
			id: "patient",
			action: "own",
			writes: [
				{
					property: "score",
					value: arith("*", read("points"), term(literal(2))),
				},
			],
		},
	];
	const nameColumn = (key: string) =>
		plainColumn(uuid(`${key}-name-column`), "case_name", "Name");
	return buildDoc(
		{
			appId: ID,
			appName: "Patient care",
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "district",
							label: proseText("District"),
							data_type: "text",
						},
					],
				},
				{
					name: "patient",
					parent_type: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "village", label: proseText("Village"), data_type: "text" },
						{
							name: "weight",
							label: proseText("Weight"),
							data_type: "decimal",
						},
						{ name: "note", label: proseText("Note"), data_type: "text" },
						{ name: "risk", label: proseText("Risk"), data_type: "text" },
						{ name: "score", label: proseText("Score"), data_type: "int" },
					],
				},
				{
					name: "contact",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "dose",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("patients"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListOf([nameColumn("patients")]),
					forms: [
						{
							uuid: register,
							name: "Register patient",
							type: "registration",
							openCondition: "#form/consent = 'yes'",
							closeCondition: `#form/outcome = '${movedValue}'`,
							fields: [
								select("consent", "Consent given?", ["yes", "no"]),
								text("patient-name", "Patient name"),
								f({
									kind: "int",
									uuid: uuid("age"),
									id: "age",
									label: proseText("Age"),
								}),
								text("village", "Village"),
								text("contact-name", "Contact name"),
								f({
									kind: "repeat",
									uuid: uuid("doses"),
									id: "doses",
									label: proseText("Doses"),
									children: [
										text("dose-name", "Dose"),
										select("given", "Given?", ["yes", "no"]),
									],
								}),
								select("outcome", "Outcome", ["staying", movedValue]),
							],
						},
						{
							uuid: check,
							name: "Check patient",
							type: "followup",
							fields: [
								f({
									kind: "decimal",
									uuid: uuid("weight"),
									id: "weight",
									label: proseText("Weight"),
									default_value: "#patient/weight",
								}),
								text("note", "Note"),
								text("district", "District"),
								text("risk", "Risk"),
							],
						},
						{
							uuid: score,
							name: "Score patient",
							type: "followup",
							fields: [
								f({
									kind: "int",
									uuid: uuid("points"),
									id: "points",
									label: proseText("Points"),
								}),
							],
						},
						{
							uuid: uuid("discharge"),
							name: "Discharge",
							type: "close",
							closeCondition: "#form/reason = 'recovered'",
							fields: [select("reason", "Reason", ["recovered", "referred"])],
						},
					],
				},
				{
					// The cases the registration creates are listed in menus of their own.
					uuid: uuid("households"),
					name: "Households",
					caseType: "household",
					caseListMenuItem: {},
					caseListConfig: caseListOf([nameColumn("households")]),
					forms: [],
				},
				{
					uuid: uuid("contacts"),
					name: "Contacts",
					caseType: "contact",
					caseListMenuItem: {},
					caseListConfig: caseListOf([nameColumn("contacts")]),
					forms: [],
				},
				{
					uuid: uuid("doses-list"),
					name: "Doses",
					caseType: "dose",
					caseListMenuItem: {},
					caseListConfig: caseListOf([nameColumn("doses-list")]),
					forms: [],
				},
			],
		},
		(built) => {
			built.forms[register].caseOperations = registerOperations;
			built.forms[check].caseOperations = checkOperations;
			built.forms[score].caseOperations = scoreOperations;
			built.userProperties = {
				[workerVillage]: {
					uuid: workerVillage,
					slug: "last_village",
					label: "Last village",
				},
			};
			built.userPropertyOrder = [workerVillage];
		},
	);
}

export function caseWritesOneConcept() {
	const check = uuid("check");
	const restore = restoreXml({
		cases: [
			{ id: "targeted-household", type: "household", name: "Hill farm" },
			{
				id: "targeted-amina",
				type: "patient",
				name: "Amina",
				properties: { weight: "64" },
				indices: [
					{
						identifier: "parent",
						caseType: "household",
						caseId: "targeted-household",
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["22, case writes as one concept", "28, load-time values"],
		doc: patients("moved"),
		edit: patients("relocated"),
		expected: {
			intent: [
				{
					id: "check-opens",
					export: "local",
					form: check,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f1", data: { case_id: "targeted-amina" } },
						expressions: ["/data/weight", "/data/note"],
					},
					expect: [
						{ pointer: "/values/0/value", value: "64" },
						{ pointer: "/values/1/value", value: "" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
