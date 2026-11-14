// lib/domain/menuForms.ts
//
// Which of a module's forms are menu items. The form a module's
// `after-empty-search` registration names is reached another way (from
// Results after a search found nothing) and is listed nowhere: not on the
// module menu, not as a link target, not in the wire's module. The form an
// `always` arm names stays on its own menu and is an ordinary form there.
// Every reader that walks "the module's forms" for a menu, a session, or a
// navigation decision goes through these.

import type { BlueprintDoc } from "./blueprint";
import { type Form, isCaseFirstModule } from "./forms";
import {
	type AlwaysOfferedRegistration,
	type CaseListRegistrationReturn,
	moduleFormsReadSearch,
	moduleHasCaseListMenuItem,
} from "./modules";
import { effectivePostSubmit, moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

type MenuFormDoc = Pick<BlueprintDoc, "forms" | "formOrder" | "modules">;
/** One form as an authoring preparation holds it before it is in the doc. */
export type PreparedMenuForm = Pick<Form, "type"> & {
	readonly formUuid: Uuid;
};

/** The module's menu forms, in order: every form of the module except its
 *  case list registration form. */
export function menuFormUuidsOf(
	doc: MenuFormDoc,
	moduleUuid: Uuid,
	prepared?: PreparedMenuForm,
): Uuid[] {
	const registration = afterEmptySearchRegistrationFormOf(doc, moduleUuid);
	return (doc.formOrder[moduleUuid] ?? []).filter((formUuid) => {
		if (formUuid === registration) return false;
		const form =
			prepared?.formUuid === formUuid ? prepared : doc.forms[formUuid];
		return form !== undefined;
	});
}

/** The registration form the module's case list offers after a search finds
 *  nothing, which is on no menu; undefined for the `always` arm and for no
 *  slot. */
export function afterEmptySearchRegistrationFormOf(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
): Uuid | undefined {
	const slot = doc.modules[moduleUuid]?.caseListRegistrationForm;
	return slot?.kind === "after-empty-search" ? slot.formUuid : undefined;
}

/** The module's `always` arm: a registration form of another menu its case
 *  list always offers. */
export function alwaysOfferedRegistrationOf(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
): AlwaysOfferedRegistration | undefined {
	const slot = doc.modules[moduleUuid]?.caseListRegistrationForm;
	return slot?.kind === "always" ? slot : undefined;
}

/** The modules whose `always` arm names the form, in `moduleOrder`. */
export function caseListsOffering(
	doc: Pick<BlueprintDoc, "modules" | "moduleOrder">,
	formUuid: Uuid,
): Uuid[] {
	return doc.moduleOrder.filter(
		(moduleUuid) =>
			alwaysOfferedRegistrationOf(doc, moduleUuid)?.formUuid === formUuid,
	);
}

/** The form the module's case list offers under either arm. */
export function offeredRegistrationFormOf(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
): Uuid | undefined {
	return doc.modules[moduleUuid]?.caseListRegistrationForm?.formUuid;
}

/** Where a worker goes after registering from an `always` host's case list. */
export type CaseListRegistrationReturnOf =
	| { readonly kind: "own" }
	| { readonly kind: CaseListRegistrationReturn };

/**
 * Where a worker who registers from the host's case list goes: `own` where
 * the form's own after-submit writes a frame (it holds links, or its
 * after-submit is anything but Home), since CommCare HQ then writes no return
 * frame (`workflow.py::WorkflowHelper._get_stack_frames`); else the arm's
 * `afterSubmit`. Undefined for a host with no `always` arm, or whose form is
 * not in the app.
 */
export function caseListRegistrationReturnOf(
	doc: Pick<BlueprintDoc, "forms" | "formOrder" | "modules">,
	hostUuid: Uuid,
): CaseListRegistrationReturnOf | undefined {
	const slot = alwaysOfferedRegistrationOf(doc, hostUuid);
	if (slot === undefined) return undefined;
	const form = doc.forms[slot.formUuid];
	if (form === undefined) return undefined;
	if (
		form.formLinks !== undefined ||
		effectivePostSubmit(doc, slot.formUuid) !== "app_home"
	)
		return { kind: "own" };
	return { kind: slot.afterSubmit };
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
 * inside an `after-empty-search` registration form and inside any form of
 * a menu whose forms read the search, against the Search prompts of that
 * form's own module, and only an exact, unambiguous name; every other form
 * gets a resolver that binds nothing, so `#search/` stays text there and the
 * gate refuses it.
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
		moduleUuid === undefined ||
		module === undefined ||
		!(
			afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid ||
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
