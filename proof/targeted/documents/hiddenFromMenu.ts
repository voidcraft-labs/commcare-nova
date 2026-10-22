/**
 * `hiddenFromMenu`: a menu and forms that are off the menu, reached by after
 * submit links and by entry points.
 *
 * "Start" holds two forms, each linking with no condition to a target off
 * the menu: one to the hidden form "Hidden with rest" in "Targets", one to
 * "Inside" in the hidden menu "Off the menu". "Targets" holds a shown form
 * and two hidden forms: "Hidden with rest" keeps a display condition for
 * when it is back on the menu, `not(role = 'supervisor')` over the worker's
 * user data, and its entry point ignores display conditions; "Hidden plain"
 * holds no condition and its entry point does not ignore them. The hidden
 * menu's two forms are the same pair, "Inside" with an entry point that
 * ignores display conditions and "Inside plain" with one that does not.
 *
 * Nova writes an item off the menu as `false()`, or `false() and (<rest>)`
 * where a condition stays, on the menu's `module_filter` or the form's
 * `form_filter` and in the local suite's `relevant`
 * (`lib/commcare/suite/displayConditions.ts`). The menus list neither
 * hidden form nor the hidden menu. A link to a hidden form opens it on
 * Android and lands on the menu that holds it in Web Apps; a link to a form
 * in the hidden menu opens it on Android and lands on the app's first
 * screen in Web Apps; an entry point opens its form on Android whatever it
 * says, and in Web Apps only where it ignores display conditions
 * (Formplayer's `MenuSessionRunnerService` alone reads `respect-relevancy`).
 * A link to the hidden menu itself is refused by Nova's gate
 * (`HIDDEN_MENU_NOT_A_DESTINATION`), so no admitted document holds one.
 *
 * Every form is a survey, so each goes to the app's home after submit by
 * its type's default.
 *
 * Fixed values: each form's note holds the text the worker enters
 * (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText, type Uuid } from "@/lib/domain";
import { eq, literal, not, sessionUser } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hidden-from-menu";
const uuid = (name: string) => targetedUuid(ID, name);

function note(name: string) {
	return f({
		kind: "text",
		uuid: uuid(`note-${name}`),
		id: "note",
		label: proseText("Note"),
	});
}

function survey(name: string, title: string) {
	return {
		uuid: uuid(`form-${name}`),
		name: title,
		type: "survey" as const,
		fields: [note(name)],
	};
}

function linkTo(name: string, moduleUuid: Uuid, formUuid: Uuid) {
	return {
		uuid: uuid(`link-${name}`),
		target: { type: "form" as const, moduleUuid, formUuid },
	};
}

export function hiddenFromMenu() {
	const targets = uuid("module-targets");
	const offTheMenu = uuid("module-off-the-menu");
	const hiddenRest = uuid("form-hidden-rest");
	const inside = uuid("form-inside");
	const source = uuid("form-to-hidden-form");
	const doc = buildDoc({
		appId: ID,
		appName: "Hidden menus",
		modules: [
			{
				uuid: uuid("module-start"),
				name: "Start",
				forms: [
					{
						...survey("to-hidden-form", "To hidden form"),
						formLinks: [linkTo("hidden-form", targets, hiddenRest)],
					},
					{
						...survey("to-inside", "To inside"),
						formLinks: [linkTo("inside", offTheMenu, inside)],
					},
				],
			},
			{
				uuid: targets,
				name: "Targets",
				forms: [
					survey("shown", "Shown"),
					{
						...survey("hidden-rest", "Hidden with rest"),
						displayCondition: not(
							eq(sessionUser("role"), literal("supervisor")),
						),
					},
					survey("hidden-plain", "Hidden plain"),
				],
			},
			{
				uuid: offTheMenu,
				name: "Off the menu",
				forms: [
					survey("inside", "Inside"),
					survey("inside-plain", "Inside plain"),
				],
			},
		],
	});
	const form = (formUuid: Uuid) => {
		const found = doc.forms[formUuid];
		if (found === undefined) throw new Error(`No form ${formUuid}.`);
		return found;
	};
	const module = doc.modules[offTheMenu];
	if (module === undefined) throw new Error("No module Off the menu.");
	module.hiddenFromMenu = true;
	form(hiddenRest).hiddenFromMenu = true;
	form(uuid("form-hidden-plain")).hiddenFromMenu = true;
	form(uuid("form-shown")).entryPoint = {
		uuid: uuid("entry-shown-form"),
		id: "shown_form",
	};
	form(hiddenRest).entryPoint = {
		uuid: uuid("entry-hidden-rest"),
		id: "hidden_rest",
		ignoreDisplayConditions: true,
	};
	form(uuid("form-hidden-plain")).entryPoint = {
		uuid: uuid("entry-hidden-plain"),
		id: "hidden_plain",
	};
	form(inside).entryPoint = {
		uuid: uuid("entry-inside"),
		id: "inside",
		ignoreDisplayConditions: true,
	};
	form(uuid("form-inside-plain")).entryPoint = {
		uuid: uuid("entry-inside-plain"),
		id: "inside_plain",
	};
	return targetedDocument({
		id: ID,
		rows: ["hiddenFromMenu, a menu and forms off the menu"],
		doc,
		expected: {
			intent: [answerHeld("note-held", source, "/data/note", "fed")],
		},
	});
}
