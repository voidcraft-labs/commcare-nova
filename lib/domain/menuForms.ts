// lib/domain/menuForms.ts
//
// Which of a module's forms are menu items. A form with an `entry` is
// reached another way (today: from Results after a search found nothing)
// and is listed nowhere: not on the module menu, not as a link target, not
// in the wire's module. Every reader that walks "the module's forms" for a
// menu, a session, or a navigation decision goes through these.

import type { BlueprintDoc } from "./blueprint";
import {
	type Form,
	formEntersFromMenu,
	isCaseFirstModule,
	isNoMatchesForm,
} from "./forms";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";
import type { ResolveSearchInputName } from "./xpath/resolve";

type MenuFormDoc = Pick<BlueprintDoc, "forms" | "formOrder">;

/** The module's menu forms, in order. */
export function menuFormUuidsOf(doc: MenuFormDoc, moduleUuid: Uuid): Uuid[] {
	return (doc.formOrder[moduleUuid] ?? []).filter((formUuid) => {
		const form = doc.forms[formUuid];
		return form !== undefined && formEntersFromMenu(form);
	});
}

/** The module's one no-matches registration form, when it has one. */
export function noMatchesFormOf(
	doc: MenuFormDoc,
	moduleUuid: Uuid,
): Form | undefined {
	for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
		const form = doc.forms[formUuid];
		if (form !== undefined && isNoMatchesForm(form)) return form;
	}
	return undefined;
}

/** The module whose `formOrder` lists the form, when any does. */
/**
 * The parse-side `#search/<name>` resolver for one form. It resolves
 * only inside a no-matches registration form, against the Search prompts
 * of that form's own module, and only an exact, unambiguous name; every
 * other form gets a resolver that binds nothing, so `#search/` stays text
 * there and the gate refuses it.
 */
export function searchInputNameResolver(
	doc: Pick<BlueprintDoc, "forms" | "formOrder" | "modules">,
	formUuid: Uuid | undefined,
): ResolveSearchInputName {
	if (formUuid === undefined) return () => undefined;
	const form = doc.forms[formUuid];
	if (form === undefined || !isNoMatchesForm(form)) return () => undefined;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const inputs =
		moduleUuid === undefined
			? []
			: (doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? []);
	return (name) => {
		const matches = inputs.filter((input) => input.name === name);
		return matches.length === 1 ? matches[0].uuid : undefined;
	};
}

/**
 * Whether the module lands on its case list: `isCaseFirstModule` over the
 * MENU forms only. A no-matches registration form is not a menu item, so
 * it never turns a search-first module forms-first.
 */
export function moduleIsCaseFirst(
	doc: Pick<BlueprintDoc, "forms" | "formOrder" | "modules">,
	moduleUuid: Uuid,
): boolean {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return false;
	const types = menuFormUuidsOf(doc, moduleUuid).flatMap((formUuid) => {
		const form = doc.forms[formUuid];
		return form === undefined ? [] : [form.type];
	});
	return isCaseFirstModule(types, mod.caseType !== undefined);
}
