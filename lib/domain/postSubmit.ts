// lib/domain/postSubmit.ts
//
// Where a form goes after submit, resolved against its module. The stored
// slot is optional; the default depends on the form type AND on the owning
// module's shape (forms that read the search, several-case selection, its
// parent's selection, whether it is off the menu, whether it or its parent
// shows its forms in the menu above, whether it opens through the first
// menu with a chosen case), so every consumer reads it here
// rather than pairing `form.postSubmit ?? defaultPostSubmit(form.type)` by
// hand. The offered set is the one statement of which destinations a form
// may hold, and, less `app_home`, which built-in otherwise; the validator,
// the reducers and the builder's pickers all read it.

import type { BlueprintDoc } from "./blueprint";
import {
	defaultPostSubmit,
	OTHERWISE_DESTINATIONS,
	type OtherwiseDestination,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
	type PostSubmitMenuShape,
} from "./forms";
import { moduleIsBareCaseList } from "./menuForms";
import { firstMenuOpensOneCase } from "./menuScreens";
import { caseSelectionCardinality, moduleFormsReadSearch } from "./modules";
import type { Uuid } from "./uuid";

type PostSubmitDoc = Pick<
	BlueprintDoc,
	"forms" | "modules" | "formOrder" | "moduleOrder"
>;

/** The module that owns `formUuid`, or `undefined` for an unknown form. */
export function moduleUuidOfForm(
	doc: Pick<BlueprintDoc, "formOrder">,
	formUuid: Uuid,
): Uuid | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
}

/**
 * Why a destination is withheld from a form, in the order the validator
 * reports them: the first reason that withholds a stored destination is the
 * one its finding names.
 */
export const POST_SUBMIT_NOT_OFFERED_REASONS = [
	"menu-selects-several",
	"parent-selects-several",
	"menu-forms-read-search",
	"menu-is-bare-case-list",
	"no-parent-menu",
	"menu-off-the-menu",
	"parent-off-the-menu",
	"menu-forms-in-menu-above",
	"parent-forms-in-menu-above",
	"menu-forms-on-first-menu",
	"menu-opens-with-first-menu-case",
] as const;
export type PostSubmitNotOfferedReason =
	(typeof POST_SUBMIT_NOT_OFFERED_REASONS)[number];

/** The destinations each reason withholds. */
const WITHHELD_BY: Readonly<
	Record<PostSubmitNotOfferedReason, readonly PostSubmitDestination[]>
> = {
	"menu-selects-several": ["previous"],
	"parent-selects-several": ["module", "parentMenu", "previous"],
	"menu-forms-read-search": ["previous"],
	"menu-is-bare-case-list": ["module"],
	"no-parent-menu": ["parentMenu"],
	"menu-off-the-menu": ["module", "previous"],
	"parent-off-the-menu": ["parentMenu"],
	"menu-forms-in-menu-above": ["module"],
	"parent-forms-in-menu-above": ["parentMenu"],
	"menu-forms-on-first-menu": ["previous"],
	"menu-opens-with-first-menu-case": ["module"],
};

/** The facts of a form's module the offered set reads. */
export interface PostSubmitModuleFacts extends PostSubmitMenuShape {
	readonly moduleUuid: Uuid;
	readonly parentUuid: Uuid | undefined;
	/** A case list menu entry and no menu forms (`moduleIsBareCaseList`). */
	readonly bareCaseList: boolean;
	readonly parentOffTheMenu: boolean;
	/** The parent shows its forms in the menu above, so it has no screen of
	 *  its own to land on. */
	readonly parentFormsInMenuAbove: boolean;
}

/**
 * One pass's reading of `menuScreens.ts::firstMenuOpensOneCase`: worked out
 * at the first form that needs it, then the same answer for the rest of the
 * pass. A pass holds one only while no write it makes changes the menus, the
 * forms' types or which menu holds which form, which is all the fact reads;
 * a reducer's own pass writes only after-submit slots. Nothing keeps it past
 * the pass, so it never outlives a reducer's write to the same draft.
 */
export type FirstMenuCaseRead = () => boolean;

export function firstMenuCaseRead(doc: PostSubmitDoc): FirstMenuCaseRead {
	let value: boolean | undefined;
	return () => {
		value ??= firstMenuOpensOneCase(doc);
		return value;
	};
}

/** The menu shape of `moduleUuid`, as the after-submit rules read it.
 *  `firstMenuCase` is the pass's reading of the shared first-menu case; a
 *  call with none reads it afresh. */
export function postSubmitModuleFacts(
	doc: PostSubmitDoc,
	moduleUuid: Uuid,
	firstMenuCase: FirstMenuCaseRead = firstMenuCaseRead(doc),
): PostSubmitModuleFacts | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return undefined;
	const parentUuid = mod.parentModuleUuid;
	const parent = parentUuid === undefined ? undefined : doc.modules[parentUuid];
	return {
		moduleUuid,
		parentUuid: parent === undefined ? undefined : parentUuid,
		formsReadSearch: moduleFormsReadSearch(mod),
		multiSelect: caseSelectionCardinality(mod) === "multiple",
		parentMultiSelect:
			parent !== undefined && caseSelectionCardinality(parent) === "multiple",
		offTheMenu: mod.hiddenFromMenu === true,
		bareCaseList: moduleIsBareCaseList(doc, moduleUuid),
		parentOffTheMenu: parent?.hiddenFromMenu === true,
		formsInMenuAbove: mod.formsInMenuAbove === true,
		// `menuScreens.ts::menuScreenOf` is the first menu exactly here: above
		// and top-level (or under a parent that does not exist), or above under
		// a parent that is above too.
		formsOnFirstMenu:
			mod.formsInMenuAbove === true &&
			(parent === undefined || parent.formsInMenuAbove === true),
		parentFormsInMenuAbove: parent?.formsInMenuAbove === true,
		// HQ builds the frame to the screen of a menu that keeps it under a
		// top-level menu above as the root lists' common prefix then the
		// menu's command (`workflow.py::_frame_children_for_module`), which
		// opens with the case every form listed from a menu above opens.
		opensWithFirstMenuCase:
			mod.formsInMenuAbove !== true &&
			parent?.formsInMenuAbove === true &&
			firstMenuCase(),
	};
}

/** Every reason that holds for a module of this shape, in report order. */
function reasonsThatHold(
	facts: PostSubmitModuleFacts,
): PostSubmitNotOfferedReason[] {
	const holds: Record<PostSubmitNotOfferedReason, boolean> = {
		"menu-selects-several": facts.multiSelect === true,
		"parent-selects-several": facts.parentMultiSelect === true,
		"menu-forms-read-search": facts.formsReadSearch === true,
		"menu-is-bare-case-list": facts.bareCaseList,
		"no-parent-menu": facts.parentUuid === undefined,
		"menu-off-the-menu": facts.offTheMenu === true,
		"parent-off-the-menu": facts.parentOffTheMenu,
		"menu-forms-in-menu-above": facts.formsInMenuAbove === true,
		"parent-forms-in-menu-above": facts.parentFormsInMenuAbove,
		"menu-forms-on-first-menu": facts.formsOnFirstMenu === true,
		"menu-opens-with-first-menu-case": facts.opensWithFirstMenuCase === true,
	};
	return POST_SUBMIT_NOT_OFFERED_REASONS.filter((reason) => holds[reason]);
}

function destinationsLeft(
	reasons: readonly PostSubmitNotOfferedReason[],
): PostSubmitDestination[] {
	const withheld = new Set(reasons.flatMap((reason) => WITHHELD_BY[reason]));
	return POST_SUBMIT_DESTINATIONS.filter(
		(destination) => !withheld.has(destination),
	);
}

/** The destinations a form of a module with these facts is offered. */
export function postSubmitDestinationsOfferedFor(
	facts: PostSubmitModuleFacts,
): PostSubmitDestination[] {
	return destinationsLeft(reasonsThatHold(facts));
}

/**
 * The destinations `formUuid` is offered, in `POST_SUBMIT_DESTINATIONS`
 * order. `app_home` and `firstMenu` always; `module` unless the parent
 * selects several cases, the module is a bare case list, the module is off
 * the menu, it shows its forms in the menu above, or it opens through the
 * first menu with the case every form listed there opens; `previous` unless the
 * module or its parent selects several cases, the module's forms read the
 * search, the module is off the menu, or its forms list on the app's first
 * menu; `parentMenu` when the module has a parent that neither selects
 * several cases, is off the menu, nor shows its forms in the menu above. An
 * unknown form, or one in no module, is offered the two that need no module.
 */
export function postSubmitDestinationsOffered(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	firstMenuCase?: FirstMenuCaseRead,
): PostSubmitDestination[] {
	const facts = factsOfForm(doc, formUuid, firstMenuCase);
	if (facts === undefined) return ["app_home", "firstMenu"];
	return postSubmitDestinationsOfferedFor(facts);
}

/**
 * The built-in otherwise destinations `formUuid` is offered: the offered
 * after-submit set less `app_home`, which an absent otherwise means. In
 * `OTHERWISE_DESTINATIONS` order.
 */
export function otherwiseDestinationsOffered(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	firstMenuCase?: FirstMenuCaseRead,
): OtherwiseDestination[] {
	const offered = new Set<PostSubmitDestination>(
		postSubmitDestinationsOffered(doc, formUuid, firstMenuCase),
	);
	return OTHERWISE_DESTINATIONS.filter((destination) =>
		offered.has(destination),
	);
}

/**
 * The destinations a picker lists for `formUuid`: the offered set, in
 * `POST_SUBMIT_DESTINATIONS` order. A stored destination outside it is a
 * finding, which the picker shows as it shows any finding.
 */
export function postSubmitDestinationChoices(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitDestination[] {
	return postSubmitDestinationsOffered(doc, formUuid);
}

/**
 * The first reason, in report order, that withholds `destination` from
 * `formUuid`, or `undefined` while the form is offered it. Reads the
 * offered set, for an after-submit destination and an otherwise alike.
 */
export function postSubmitNotOfferedReason(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	destination: PostSubmitDestination,
	firstMenuCase?: FirstMenuCaseRead,
): PostSubmitNotOfferedReason | undefined {
	const facts = factsOfForm(doc, formUuid, firstMenuCase);
	if (facts === undefined) return undefined;
	return reasonsThatHold(facts).find((reason) =>
		WITHHELD_BY[reason].includes(destination),
	);
}

/** The after-submit default of `formUuid`, given its type and module. */
export function defaultPostSubmitOf(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	firstMenuCase?: FirstMenuCaseRead,
): PostSubmitDestination | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	return defaultPostSubmit(
		form.type,
		factsOfForm(doc, formUuid, firstMenuCase) ?? {},
	);
}

/**
 * Where `formUuid` goes after submit when it has no destinations: its stored
 * slot, else its default. `undefined` for an unknown form and for a form
 * that holds `formLinks`, whose after-submit is its destinations and its
 * `otherwise` (`afterSubmit.ts`).
 */
export function effectivePostSubmit(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	firstMenuCase?: FirstMenuCaseRead,
): PostSubmitDestination | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined || form.formLinks !== undefined) return undefined;
	return form.postSubmit ?? defaultPostSubmitOf(doc, formUuid, firstMenuCase);
}

function factsOfForm(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	firstMenuCase?: FirstMenuCaseRead,
): PostSubmitModuleFacts | undefined {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	return moduleUuid === undefined
		? undefined
		: postSubmitModuleFacts(doc, moduleUuid, firstMenuCase);
}
