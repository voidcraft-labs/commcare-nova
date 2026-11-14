/**
 * Menus that show their forms in the menu above (`Module.formsInMenuAbove`,
 * CommCare HQ's `put_in_root`), in the starter shape and its neighbours
 * (`targeted-forms-in-menu-above`). The first menu lists a registration
 * form beside follow-up forms, so it shares no one case and the frames HQ
 * builds through it hold no case ahead of their first command
 * (`workflow.py::WorkflowHelper.get_frame_children`, `_root_module_datums`).
 *
 * - "Registration" shows its one registration form on the first menu, with
 *   an icon and a display condition, which then gate that form there.
 * - "Clinic" is an ordinary case-first menu between the two menus above. Its
 *   follow-up form links to "Visit", a form listed on the first menu.
 * - "Visits" shows on the first menu a follow-up form with no stored
 *   after-submit (its default there is the first menu, since the previous
 *   screen is not offered to a form the first menu lists), a second follow-up
 *   form sent to Home, and its case list entry. "Visit" holds an entry point.
 * - "Archive" shows its survey above and is off the menu; its submenu
 *   "Archive tasks" keeps its screen, so it stays listed on the first menu by
 *   its own condition alone.
 *
 * D′ gives "Archive" its own screen again (proof 5). It declares both
 * platforms. Fixed value: the archive task's question holds the text the
 * worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setModuleFormsInMenuAboveMutation } from "@/lib/doc/displayConditionMutations";
import { plainColumn, proseText } from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-forms-in-menu-above";
const uuid = (name: string) => targetedUuid(ID, name);

/** A follow-up form of the patient case with one note question. */
function followUp(key: string, name: string, extra: object = {}) {
	return {
		uuid: uuid(key),
		name,
		type: "followup" as const,
		...extra,
		fields: [
			f({
				uuid: uuid(`${key}-note`),
				kind: "text",
				id: "note",
				label: proseText("Note"),
			}),
		],
	};
}

/** A survey with one question. */
function survey(key: string, name: string) {
	return {
		uuid: uuid(key),
		name,
		type: "survey" as const,
		fields: [
			f({
				uuid: uuid(`${key}-question`),
				kind: "text",
				id: "question",
				label: proseText("Question"),
			}),
		],
	};
}

const patients = (key: string) =>
	caseListOf([plainColumn(uuid(`${key}-name`), "case_name", "Name")]);

export function formsInMenuAbove() {
	const task = uuid("archive-task");
	const doc = buildDoc({
		appId: ID,
		appName: "Forms in the menu above",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("registration"),
				name: "Registration",
				caseType: "patient",
				displayCondition: eq(sessionUser("role"), literal("registrar")),
				caseListConfig: patients("registration"),
				forms: [
					{
						uuid: uuid("register"),
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								uuid: uuid("register-name"),
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: uuid("clinic"),
				name: "Clinic",
				caseType: "patient",
				caseListConfig: patients("clinic"),
				forms: [
					followUp("clinic-visit", "Clinic visit", {
						formLinks: [
							{
								uuid: uuid("clinic-visit-link"),
								target: {
									type: "form",
									moduleUuid: uuid("visits"),
									formUuid: uuid("visit"),
								},
							},
						],
					}),
				],
			},
			{
				uuid: uuid("visits"),
				name: "Visits",
				caseType: "patient",
				caseListMenuItem: {},
				caseListConfig: patients("visits"),
				forms: [
					followUp("visit", "Visit"),
					followUp("check", "Check", { postSubmit: "app_home" }),
				],
			},
			{
				uuid: uuid("archive"),
				name: "Archive",
				forms: [survey("archive-survey", "Archive survey")],
			},
			{
				uuid: uuid("archive-tasks"),
				name: "Archive tasks",
				forms: [survey("archive-task", "Archive task")],
			},
		],
	});
	doc.modules[uuid("registration")].formsInMenuAbove = true;
	doc.modules[uuid("registration")].icon = "nova-icon:patient";
	doc.modules[uuid("visits")].formsInMenuAbove = true;
	doc.modules[uuid("archive")].formsInMenuAbove = true;
	doc.modules[uuid("archive")].hiddenFromMenu = true;
	doc.modules[uuid("archive-tasks")].parentModuleUuid = uuid("archive");
	doc.forms[uuid("visit")].entryPoint = {
		uuid: uuid("visit-entry"),
		id: "visit",
	};
	// D′ gives "Archive" its own screen again, as the module settings switch
	// does.
	const edit = structuredClone(doc);
	delete edit.modules[uuid("archive")].formsInMenuAbove;
	return targetedDocument({
		id: ID,
		rows: [
			"forms in the menu above: the starter shape, a link and an entry point into a form the first menu lists, a menu above off the menu with a submenu that keeps its screen",
		],
		doc,
		edit,
		editMutations: [setModuleFormsInMenuAboveMutation(uuid("archive"), false)],
		expected: {
			intent: [answerHeld("archive-task-held", task, "/data/question", "seen")],
		},
	});
}
