/**
 * Defect 26: a destination whose carried case is not on the device does not
 * run (`targeted-form-link-carried-case`).
 *
 * HQ's build writes a link's carried values into its frame as they stand
 * (`suite_xml/post_process/workflow.py::_get_datums_matched_to_manual_values`),
 * and a form opened on a case id the device does not hold submits an update
 * to a case nothing created, which HQ's case processing makes a case of,
 * noting it as a case created without a create block
 * (`form_processor/casedb_base.py::AbstractCaseDbCache.get_case_from_case_update`). Nova conjoins to each
 * destination that carries a value onto a single-case selection the test
 * that the device holds a case of that type with that id
 * (`count(instance('casedb')/casedb/case[@case_id = V and @case_type = 'T']) > 0`),
 * which Core evaluates once the submission has landed.
 *
 * "Households" (`household`) holds "Add household" and two follow-ups that
 * each register a member of the household chosen, "Register member" and
 * "Register member quietly"; its submenu "Members" (`member`, a child of
 * `household`, chosen after its household) holds "Check member". Register
 * member's three destinations all open Check member, each carrying the
 * household and, as the member, the literal `'no-such-case'`, the new member
 * (the case the form creates, its entry's `case_id_new_member_0`), and the
 * household (a case of the wrong type); its otherwise is the app's first
 * menu. Register member quietly holds only the literal and the household
 * destinations and the same otherwise. So after Register member only the
 * destination carrying the new member opens, which the test reads after the
 * submission has landed, and after Register member quietly the otherwise
 * does. Every case the walk reads it makes itself; no case is seeded.
 *
 * Fixed values: Add household's name holds the text the worker enters
 * (`./echo.ts`), on the new household's id its entry makes.
 */

import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	type Uuid,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-form-link-carried-case";
const uuid = (name: string) => targetedUuid(ID, name);

const HOUSEHOLD = "household";
const MEMBER = "member";
const HOUSEHOLDS = uuid("module-households");
const MEMBERS = uuid("module-members");
const ADD_HOUSEHOLD = uuid("form-add-household");
const CHECK_MEMBER = uuid("form-check-member");

type FormLinks = NonNullable<FormSpec["formLinks"]>;

/** The household the worker chose, whose member the form registers. */
const HOUSEHOLD_ID = "#household/case_id";
/** The member the form creates, a child of the chosen household. */
const NEW_MEMBER_ID =
	"instance('commcaresession')/session/data/case_id_new_member_0";

function nameField(key: string, caseType: string) {
	return f({
		kind: "text",
		uuid: uuid(`name-${key}`),
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType, property: "case_name" },
	});
}

/** A destination to Check member carrying the form's household and, as the
 *  member, `member`. */
function toCheckMember(key: string, member: string): FormLinks[number] {
	return {
		uuid: uuid(`link-${key}`),
		target: { type: "form", moduleUuid: MEMBERS, formUuid: CHECK_MEMBER },
		datums: [
			{
				name: { kind: "selected-case", module: HOUSEHOLDS },
				xpath: HOUSEHOLD_ID,
			},
			{ name: { kind: "selected-case", module: MEMBERS }, xpath: member },
		],
	};
}

function caseModule(
	moduleUuid: Uuid,
	name: string,
	caseType: string,
	forms: FormSpec[],
	parent?: Uuid,
) {
	return {
		uuid: moduleUuid,
		name,
		caseType,
		...(parent !== undefined && { parentCaseModuleUuid: parent }),
		caseListConfig: caseListOf([
			plainColumn(uuid(`column-${name}`), "case_name", "Name"),
		]),
		forms,
	};
}

function carriedCaseApp(): BlueprintDoc {
	const literal = (key: string) => toCheckMember(key, "'no-such-case'");
	const household = (key: string) => toCheckMember(key, HOUSEHOLD_ID);
	return buildDoc(
		{
			appId: ID,
			appName: "Member checks",
			// Declared for Web Apps and Android, as a new app is.
			appSettings: { ...NEW_APP_SETTINGS },
			caseTypes: [
				{
					name: HOUSEHOLD,
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: MEMBER,
					parent_type: HOUSEHOLD,
					relationship: "child",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				caseModule(HOUSEHOLDS, "Households", HOUSEHOLD, [
					{
						uuid: ADD_HOUSEHOLD,
						name: "Add household",
						type: "registration",
						fields: [nameField("add-household", HOUSEHOLD)],
					},
					{
						uuid: uuid("form-register-member"),
						name: "Register member",
						type: "followup",
						formLinks: [
							literal("register-literal"),
							toCheckMember("register-new", NEW_MEMBER_ID),
							household("register-household"),
						],
						fields: [nameField("register-member", MEMBER)],
					},
					{
						uuid: uuid("form-register-member-quietly"),
						name: "Register member quietly",
						type: "followup",
						formLinks: [
							literal("quietly-literal"),
							household("quietly-household"),
						],
						fields: [nameField("register-member-quietly", MEMBER)],
					},
				]),
				caseModule(
					MEMBERS,
					"Members",
					MEMBER,
					[
						{
							uuid: CHECK_MEMBER,
							name: "Check member",
							type: "followup",
							fields: [
								f({
									kind: "text",
									uuid: uuid("note-check-member"),
									id: "note",
									label: proseText("Note"),
								}),
							],
						},
					],
					HOUSEHOLDS,
				),
			],
		},
		(built) => {
			built.modules[MEMBERS].parentModuleUuid = HOUSEHOLDS;
			for (const key of ["register-member", "register-member-quietly"]) {
				const formUuid = uuid(`form-${key}`);
				const form = built.forms[formUuid];
				if (form === undefined) throw new Error(`No ${key} form.`);
				built.forms[formUuid] = {
					...form,
					otherwise: { kind: "destination", destination: "firstMenu" },
				};
			}
		},
	);
}

export function formLinkCarriedCase() {
	return targetedDocument({
		id: ID,
		rows: ["26"],
		doc: carriedCaseApp(),
		expected: {
			intent: [
				answerHeld(
					"name-held",
					ADD_HOUSEHOLD,
					"/data/case_name",
					"Okoye",
					"local",
					{
						command: "m0-f0",
						data: { case_id_new_household_0: "targeted-new-household" },
					},
				),
			],
		},
	});
}
