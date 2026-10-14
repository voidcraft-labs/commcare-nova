/**
 * A form link whose target is never shown: what each runtime does when the
 * frame a submission leaves names a form, or a menu, that its own menu does
 * not offer.
 *
 * Three forms of one menu each link, with no condition, to one target: a
 * form shown in another menu (the control), a form of that menu whose
 * display condition is false for the worker, and a menu whose display
 * condition is false for the worker. HQ builds each link as a stack frame that names the target's
 * commands (`suite_xml/post_process/workflow.py`), and what a runtime does
 * with a command its menu screen leaves out is the runtime's own:
 * Formplayer walks the frame through the menu screens it would show
 * (`services/MenuSessionFactory.java::rebuildSessionFromFrame`), where Core's
 * session reads the frame's commands as they stand.
 *
 * Fixed values: each form's note holds the text the worker enters
 * (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/predicate";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-form-link-hidden-target";
const uuid = (name: string) => targetedUuid(ID, name);

/**
 * False for the worker the lane's sessions run as, whose `role` is never
 * `supervisor` (`proof/observe/casedata.py::case_database`). Nova refuses a
 * condition no worker could ever meet (`DISPLAY_CONDITION_ALWAYS_FALSE`), so
 * what hides a target is always a condition over the worker or the case.
 */
function hidden() {
	return eq(sessionUser("role"), literal("supervisor"));
}

function note(name: string) {
	return f({
		kind: "text",
		uuid: uuid(`note-${name}`),
		id: "note",
		label: proseText("Note"),
	});
}

export function formLinkHiddenTarget() {
	const source = uuid("form-to-shown-form");
	const doc = buildDoc({
		appId: ID,
		appName: "Linked surveys",
		modules: [
			{
				uuid: uuid("module-start"),
				name: "Start",
				forms: [
					{
						uuid: source,
						name: "To shown form",
						type: "survey" as const,
						formLinks: [
							{
								uuid: uuid("link-shown-form"),
								target: {
									type: "form" as const,
									moduleUuid: uuid("module-targets"),
									formUuid: uuid("form-shown"),
								},
							},
						],
						fields: [note("to-shown-form")],
					},
					{
						uuid: uuid("form-to-hidden-form"),
						name: "To hidden form",
						type: "survey" as const,
						formLinks: [
							{
								uuid: uuid("link-hidden-form"),
								target: {
									type: "form" as const,
									moduleUuid: uuid("module-targets"),
									formUuid: uuid("form-hidden"),
								},
							},
						],
						fields: [note("to-hidden-form")],
					},
					{
						uuid: uuid("form-to-hidden-menu"),
						name: "To hidden menu",
						type: "survey" as const,
						formLinks: [
							{
								uuid: uuid("link-hidden-menu"),
								target: {
									type: "module" as const,
									moduleUuid: uuid("module-hidden"),
								},
							},
						],
						fields: [note("to-hidden-menu")],
					},
				],
			},
			{
				uuid: uuid("module-targets"),
				name: "Targets",
				forms: [
					{
						uuid: uuid("form-shown"),
						name: "Shown",
						type: "survey" as const,
						fields: [note("shown")],
					},
					{
						uuid: uuid("form-hidden"),
						name: "Hidden",
						type: "survey" as const,
						displayCondition: hidden(),
						fields: [note("hidden")],
					},
				],
			},
			{
				uuid: uuid("module-hidden"),
				name: "Hidden menu",
				displayCondition: hidden(),
				forms: [
					{
						uuid: uuid("form-inside"),
						name: "Inside",
						type: "survey" as const,
						fields: [note("inside")],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["58, a form link to a target its menu does not show"],
		doc,
		expected: {
			intent: [answerHeld("note-held", source, "/data/note", "fed")],
		},
	});
}
