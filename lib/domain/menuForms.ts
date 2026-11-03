// lib/domain/menuForms.ts
//
// Which of a module's forms are menu items. The form a module's
// `caseListRegistrationForm` names is reached another way (from Results
// after a search found nothing) and is listed nowhere: not on the module
// menu, not as a link target, not in the wire's module. Every reader that
// walks "the module's forms" for a menu, a session, or a navigation decision
// goes through these.

import type { BlueprintDoc } from "./blueprint";
import { type Form, isCaseFirstModule } from "./forms";
import { moduleFormsReadSearch, moduleHasCaseListMenuItem } from "./modules";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

type MenuFormDoc = Pick<BlueprintDoc, "forms" | "formOrder" | "modules">;
type PreparedMenuForm = Pick<Form, "type"> & {
	readonly formUuid: Uuid;
};

/** The module's menu forms, in order: every form of the module except its
 *  case list registration form. */
export function menuFormUuidsOf(
	doc: MenuFormDoc,
	moduleUuid: Uuid,
	prepared?: PreparedMenuForm,
): Uuid[] {
	const registration = caseListRegistrationFormOf(doc, moduleUuid);
	return (doc.formOrder[moduleUuid] ?? []).filter((formUuid) => {
		if (formUuid === registration) return false;
		const form =
			prepared?.formUuid === formUuid ? prepared : doc.forms[formUuid];
		return form !== undefined;
	});
}

/** The module's case list registration form, when its slot names one. */
export function caseListRegistrationFormOf(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
): Uuid | undefined {
	return doc.modules[moduleUuid]?.caseListRegistrationForm?.formUuid;
}

/** A case list menu entry and no menu forms: the menu is its case list. */
export function moduleIsBareCaseList(
	doc: MenuFormDoc,
	moduleUuid: Uuid,
): boolean {
	const mod = doc.modules[moduleUuid];
	return (
		mod !== undefined &&
		moduleHasCaseListMenuItem(mod) &&
		menuFormUuidsOf(doc, moduleUuid).length === 0
	);
}

/** The module whose `formOrder` lists the form, when any does. */
/**
 * The parse-side `#search/<name>` resolver for one form. It resolves
 * inside a case list registration form and inside any form of a menu whose
 * forms read the search, against the Search prompts of that form's own
 * module, and only an exact, unambiguous name; every other form gets a
 * resolver that binds nothing, so `#search/` stays text there and the gate
 * refuses it.
 */
export function searchInputNameResolver(
	doc: Pick<BlueprintDoc, "forms" | "formOrder" | "modules">,
	formUuid: Uuid | undefined,
): (name: string) => Uuid | undefined {
	if (formUuid === undefined) return () => undefined;
	const form = doc.forms[formUuid];
	if (form === undefined) return () => undefined;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (
		module === undefined ||
		!(
			module.caseListRegistrationForm?.formUuid === formUuid ||
			moduleFormsReadSearch(module)
		)
	)
		return () => undefined;
	const inputs = module.caseListConfig?.searchInputs ?? [];
	return (name) => {
		const matches = inputs.filter((input) => input.name === name);
		return matches.length === 1 ? matches[0].uuid : undefined;
	};
}

/**
 * Whether the module lands on its case list: `isCaseFirstModule` over the
 * MENU forms only. A case list registration form is not a menu item, so
 * it never turns a menu whose forms read the search forms-first.
 */
export function moduleIsCaseFirst(
	doc: Pick<BlueprintDoc, "forms" | "formOrder" | "modules">,
	moduleUuid: Uuid,
	prepared?: PreparedMenuForm,
): boolean {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return false;
	const types = menuFormUuidsOf(doc, moduleUuid, prepared).flatMap(
		(formUuid) => {
			const form =
				prepared?.formUuid === formUuid ? prepared : doc.forms[formUuid];
			return form === undefined ? [] : [form.type];
		},
	);
	return isCaseFirstModule(types, mod.caseType !== undefined);
}
