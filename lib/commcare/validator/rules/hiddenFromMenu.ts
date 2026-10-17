/**
 * `HIDDEN_MENU_NOT_A_DESTINATION`: a module that is off the menu
 * (`hiddenFromMenu`) is no screen to send a worker to. On Android such a
 * module opens as a menu screen that lists nothing; in Web Apps the worker
 * lands on the app's first screen instead (Formplayer rebuilds the session
 * through the menus it would show, `services/MenuSessionFactory.java::
 * rebuildSessionFromFrame`, and finds no menu to match). So three things that
 * would open the module itself are refused:
 *
 *   - an after-submit link whose target is the module (located at the link);
 *   - the module's own entry point (located at the module);
 *   - the module's case list entry point (located at the module).
 *
 * A link or an entry point to a FORM inside the module is admitted: Android
 * opens it, and Web Apps opens it from an entry point that ignores display
 * conditions.
 */

import type { BlueprintDoc, Form, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

type HiddenMenuArm = "link" | "entry-point" | "case-list-entry-point";

function message(moduleName: string, what: string): string {
	return `"${moduleName}" is off the menu, so ${what} would open a menu with nothing in it on Android and the app's first screen in Web Apps. Point it at a form inside the module, or show the module on the menu again.`;
}

/** A module off the menu that holds an entry point or a case list entry point. */
export function hiddenMenuEntryPoints(
	mod: Module,
	moduleUuid: Uuid,
): ValidationError[] {
	if (mod.hiddenFromMenu !== true) return [];
	const arms: { arm: HiddenMenuArm; what: string }[] = [
		...(mod.entryPoint !== undefined
			? [{ arm: "entry-point" as const, what: "its entry point" }]
			: []),
		...(mod.caseListEntryPoint !== undefined
			? [
					{
						arm: "case-list-entry-point" as const,
						what: "its case list entry point",
					},
				]
			: []),
	];
	return arms.map(({ arm, what }) =>
		validationError(
			"HIDDEN_MENU_NOT_A_DESTINATION",
			"module",
			message(mod.name, what),
			{ moduleUuid, moduleName: mod.name },
			{ arm },
		),
	);
}

/** A form's after-submit links whose target is a module off the menu. */
export function hiddenMenuLinkTargets(
	doc: BlueprintDoc,
	form: Form,
	location: {
		readonly moduleUuid: Uuid;
		readonly moduleName: string;
		readonly formUuid: Uuid;
		readonly formName: string;
	},
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const link of form.formLinks ?? []) {
		if (link.target.type !== "module") continue;
		const target = doc.modules[link.target.moduleUuid];
		if (target?.hiddenFromMenu !== true) continue;
		errors.push(
			validationError(
				"HIDDEN_MENU_NOT_A_DESTINATION",
				"form",
				message(target.name, `the link from "${form.name}"`),
				location,
				{
					arm: "link",
					linkUuid: link.uuid,
					targetModuleUuid: link.target.moduleUuid,
					targetModuleName: target.name,
				},
			),
		);
	}
	return errors;
}
