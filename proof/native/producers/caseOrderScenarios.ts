/**
 * The case family's documents for the order of case changes across their
 * places, and for a save made only when the answer changed
 * (`CaseOperationRuntimeTest`, part 01's G1):
 *
 * - `own-links`: a registration of a patient whose own case and a contact,
 *   created at the form's root, are Case Management's (`open_case` and the
 *   basic subcase `subcase_0`), beside two visits whose names are computed,
 *   so each is a Save to Case block in the root `nova_operations` group. The
 *   first visit's `parent` index names the patient the form creates, the
 *   second's the contact. Both blocks stand before the basic blocks HQ's
 *   build appends after the form's questions, so Core reads each index
 *   before the create of the case it names.
 * - `only-if-changed`: a follow-up whose own case saves a nickname, which
 *   opens with the patient's nickname, only when the worker changed it
 *   (`update_mode: edit`), beside a note it always saves.
 */

import { testUuid } from "../../../__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "../../../lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	NEW_APP_SETTINGS,
	proseText,
} from "../../../lib/domain";
import {
	concat,
	formField,
	literal,
	term,
} from "../../../lib/domain/expression";

export const caseOrderScenarios = ["own-links", "only-if-changed"] as const;
export type CaseOrderScenario = (typeof caseOrderScenarios)[number];

const uuid = (name: string) => testUuid(`case-order:${name}`);
const read = (name: string) => term(formField(uuid(name)));
const text = (name: string, id: string) =>
	f({ uuid: uuid(name), kind: "text", id, label: proseText(id) });

/** The case types the scenarios write, each with a menu that lists it. */
const CASE_TYPES = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: proseText("Name") },
			{
				name: "nickname",
				label: proseText("Nickname"),
				data_type: "text" as const,
			},
			{ name: "note", label: proseText("Note"), data_type: "text" as const },
		],
	},
	{
		name: "contact",
		parent_type: "patient",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
	{
		name: "visit",
		parent_type: "patient",
		properties: [{ name: "case_name", label: proseText("Name") }],
	},
];

const listOf = (caseType: string) => ({
	name: `${caseType} list`,
	caseType,
	caseListMenuItem: {},
	caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
	forms: [],
});

export function caseOrderDocument(scenario: CaseOrderScenario): BlueprintDoc {
	const form = uuid(`${scenario}-form`);
	const own = uuid(`${scenario}-own`);
	const operations: CaseOperation[] =
		scenario === "own-links"
			? [
					{
						uuid: own,
						id: "patient",
						action: "own",
						name: read("patient-name"),
					},
					{
						uuid: uuid("contact"),
						id: "contact",
						action: "create",
						caseType: "contact",
						target: { kind: "new" },
						name: read("contact-name"),
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: { kind: "op", opUuid: own },
								relationship: "child",
							},
						],
					},
					{
						uuid: uuid("visit-of-patient"),
						id: "visit_of_patient",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: concat(read("visit-name"), term(literal(" (patient)"))),
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: { kind: "op", opUuid: own },
								relationship: "child",
							},
						],
					},
					{
						uuid: uuid("visit-of-contact"),
						id: "visit_of_contact",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						name: concat(read("visit-name"), term(literal(" (contact)"))),
						links: [
							{
								identifier: "parent",
								targetType: "contact",
								target: { kind: "op", opUuid: uuid("contact") },
								relationship: "child",
							},
						],
					},
				]
			: [
					{
						uuid: own,
						id: "patient",
						action: "own",
						writes: [
							{
								property: "nickname",
								value: read("nickname"),
								onlyIfChanged: true,
							},
							{ property: "note", value: read("note") },
						],
					},
				];
	return buildDoc(
		{
			appName: `Case order ${scenario}`,
			// Saving only a changed answer is HQ's Case Management setting, the same on both.
			appSettings: { ...NEW_APP_SETTINGS },
			caseTypes: CASE_TYPES,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						scenario === "own-links"
							? {
									uuid: form,
									name: "Register",
									type: "registration",
									fields: [
										text("patient-name", "patient_name"),
										text("contact-name", "contact_name"),
										text("visit-name", "visit_name"),
									],
								}
							: {
									uuid: form,
									name: "Check",
									type: "followup",
									fields: [
										f({
											uuid: uuid("nickname"),
											kind: "text",
											id: "nickname",
											label: proseText("nickname"),
											default_value: "#patient/nickname",
										}),
										text("note", "note"),
									],
								},
					],
				},
				listOf("contact"),
				listOf("visit"),
			],
		},
		(built) => {
			built.forms[form].caseOperations = operations;
		},
	);
}
