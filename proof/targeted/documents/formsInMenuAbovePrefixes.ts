/**
 * The two shapes of the first menu whose frames start with something other
 * than the form's command. HQ's build puts the datums every form listed on the
 * first menu shares ahead of a form's command in a frame through it
 * (`workflow.py::WorkflowHelper.get_frame_children`, `_root_module_datums`).
 *
 * - `targeted-forms-in-menu-above-registration-only`: the one menu above
 *   holds one registration form, so the shared prefix is the computed datum
 *   of its new case, and a link and an entry point into it open with that
 *   datum ahead of its command.
 * - `targeted-forms-in-menu-above-one-case`: two menus above of one case type
 *   hold follow-up forms alone, so every form on the first menu opens one
 *   chosen case. Its menus, its entries and the first-menu frames of their
 *   default after-submit are held; Nova's gate refuses a link or an entry
 *   point into such a form, since its frame would hold that case ahead of
 *   any command.
 *
 * Both declare both platforms. Fixed values: the ordinary menu's survey
 * question holds the text the worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const note = (key: (name: string) => string, name: string) =>
	f({
		uuid: key(`${name}-note`),
		kind: "text",
		id: "note",
		label: proseText("Note"),
	});

const patientType = {
	name: "patient",
	properties: [{ name: "case_name", label: proseText("Name") }],
};

export function formsInMenuAboveRegistrationOnly() {
	const id = "targeted-forms-in-menu-above-registration-only";
	const key = (name: string) => targetedUuid(id, name);
	const doc = buildDoc({
		appId: id,
		appName: "Registration on the first menu",
		caseTypes: [patientType],
		modules: [
			{
				uuid: key("registration"),
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(key("registration-name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: key("register"),
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								uuid: key("register-name"),
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
				uuid: key("clinic"),
				name: "Clinic",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(key("clinic-name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: key("clinic-visit"),
						name: "Clinic visit",
						type: "followup",
						formLinks: [
							{
								uuid: key("clinic-visit-link"),
								target: {
									type: "form",
									moduleUuid: key("registration"),
									formUuid: key("register"),
								},
							},
						],
						fields: [note(key, "clinic-visit")],
					},
				],
			},
			{
				uuid: key("tasks"),
				name: "Tasks",
				forms: [
					{
						uuid: key("task"),
						name: "Task",
						type: "survey",
						fields: [
							f({
								uuid: key("task-question"),
								kind: "text",
								id: "question",
								label: proseText("Question"),
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[key("registration")].formsInMenuAbove = true;
	doc.forms[key("register")].entryPoint = {
		uuid: key("register-entry"),
		id: "register",
	};
	return targetedDocument({
		id,
		rows: [
			"forms in the menu above: a first menu whose forms share a computed datum, with a link and an entry point into its form",
		],
		doc,
		expected: {
			intent: [answerHeld("task-held", key("task"), "/data/question", "seen")],
		},
	});
}

export function formsInMenuAboveOneCase() {
	const id = "targeted-forms-in-menu-above-one-case";
	const key = (name: string) => targetedUuid(id, name);
	const list = (name: string) =>
		caseListOf([plainColumn(key(`${name}-name`), "case_name", "Name")]);
	const doc = buildDoc({
		appId: id,
		appName: "One case on the first menu",
		caseTypes: [patientType],
		modules: [
			{
				uuid: key("visits"),
				name: "Visits",
				caseType: "patient",
				caseListConfig: list("visits"),
				forms: [
					{
						uuid: key("visit"),
						name: "Visit",
						type: "followup",
						fields: [note(key, "visit")],
					},
				],
			},
			{
				uuid: key("checks"),
				name: "Checks",
				caseType: "patient",
				caseListConfig: list("checks"),
				forms: [
					{
						uuid: key("check"),
						name: "Check",
						type: "followup",
						fields: [note(key, "check")],
					},
					{
						uuid: key("close"),
						name: "Close patient",
						type: "close",
						fields: [note(key, "close")],
					},
				],
			},
			{
				uuid: key("tasks"),
				name: "Tasks",
				forms: [
					{
						uuid: key("task"),
						name: "Task",
						type: "survey",
						fields: [
							f({
								uuid: key("task-question"),
								kind: "text",
								id: "question",
								label: proseText("Question"),
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[key("visits")].formsInMenuAbove = true;
	doc.modules[key("checks")].formsInMenuAbove = true;
	return targetedDocument({
		id,
		rows: [
			"forms in the menu above: a first menu whose every form opens one chosen case, with its default after-submit frames",
		],
		doc,
		expected: {
			intent: [answerHeld("task-held", key("task"), "/data/question", "seen")],
		},
	});
}
