// lib/domain/postSubmit.ts
//
// Where a form goes after submit, resolved against its module. The stored
// slot is optional; the default depends on the form type AND on the owning
// module's shape (Search first, several-case selection, its parent's
// selection, whether it is off the menu), so every consumer reads it here
// rather than pairing `form.postSubmit ?? defaultPostSubmit(form.type)` by
// hand. The offered set is the one statement of which destinations a form
// may hold; the validator, the reducers, the builder's pickers and the
// cutover all read it.

import type { BlueprintDoc } from "./blueprint";
import {
	defaultPostSubmit,
	POST_SUBMIT_DESTINATIONS,
	type PostSubmitDestination,
	type PostSubmitMenuShape,
} from "./forms";
import { caseSelectionCardinality, moduleOpensOnSearch } from "./modules";
import type { Uuid } from "./uuid";

type PostSubmitDoc = Pick<BlueprintDoc, "forms" | "modules" | "formOrder">;

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
	"menu-opens-on-search",
	"menu-is-case-list-only",
	"no-parent-menu",
	"menu-off-the-menu",
	"parent-off-the-menu",
] as const;
export type PostSubmitNotOfferedReason =
	(typeof POST_SUBMIT_NOT_OFFERED_REASONS)[number];

/** The destinations each reason withholds. */
const WITHHELD_BY: Readonly<
	Record<PostSubmitNotOfferedReason, readonly PostSubmitDestination[]>
> = {
	"menu-selects-several": ["previous"],
	"parent-selects-several": ["module", "parentMenu", "previous"],
	"menu-opens-on-search": ["previous"],
	"menu-is-case-list-only": ["module"],
	"no-parent-menu": ["parentMenu"],
	"menu-off-the-menu": ["module", "previous"],
	"parent-off-the-menu": ["parentMenu"],
};

/** The two reasons a form that holds links is exempt from. */
const MULTI_SELECT_REASONS: ReadonlySet<PostSubmitNotOfferedReason> = new Set([
	"menu-selects-several",
	"parent-selects-several",
]);

/** The facts of a form's module the offered set reads. */
export interface PostSubmitModuleFacts extends PostSubmitMenuShape {
	readonly moduleUuid: Uuid;
	readonly parentUuid: Uuid | undefined;
	readonly caseListOnly: boolean;
	readonly parentOffTheMenu: boolean;
}

/** The menu shape of `moduleUuid`, as the after-submit rules read it. */
export function postSubmitModuleFacts(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
): PostSubmitModuleFacts | undefined {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined) return undefined;
	const parentUuid = mod.parentModuleUuid;
	const parent = parentUuid === undefined ? undefined : doc.modules[parentUuid];
	return {
		moduleUuid,
		parentUuid: parent === undefined ? undefined : parentUuid,
		searchFirst: moduleOpensOnSearch(mod),
		multiSelect: caseSelectionCardinality(mod) === "multiple",
		parentMultiSelect:
			parent !== undefined && caseSelectionCardinality(parent) === "multiple",
		offTheMenu: mod.hiddenFromMenu === true,
		caseListOnly: mod.caseListOnly === true,
		parentOffTheMenu: parent?.hiddenFromMenu === true,
	};
}

/** Every reason that holds for a module of this shape, in report order. */
function reasonsThatHold(
	facts: PostSubmitModuleFacts,
): PostSubmitNotOfferedReason[] {
	const holds: Record<PostSubmitNotOfferedReason, boolean> = {
		"menu-selects-several": facts.multiSelect === true,
		"parent-selects-several": facts.parentMultiSelect === true,
		"menu-opens-on-search": facts.searchFirst === true,
		"menu-is-case-list-only": facts.caseListOnly,
		"no-parent-menu": facts.parentUuid === undefined,
		"menu-off-the-menu": facts.offTheMenu === true,
		"parent-off-the-menu": facts.parentOffTheMenu,
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
 * selects several cases, the module is a bare case list, or the module is
 * off the menu; `previous` unless the module or its parent selects several
 * cases, the module opens on Search, or the module is off the menu;
 * `parentMenu` when the module has a parent that neither selects several
 * cases nor is off the menu. An unknown form, or one in no module, is
 * offered the two that need no module.
 */
export function postSubmitDestinationsOffered(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitDestination[] {
	const facts = factsOfForm(doc, formUuid);
	if (facts === undefined) return ["app_home", "firstMenu"];
	return postSubmitDestinationsOfferedFor(facts);
}

/**
 * The destinations `formUuid` may hold. A form with no links holds what it
 * is offered. A form with links holds `postSubmit` as the fallback after
 * them, and the two several-case reasons do not withhold its fallback: a
 * fallback the settings page does not offer is a later step's to settle,
 * and its documents stay admissible until then. Every other reason applies
 * with or without links.
 */
export function postSubmitDestinationsAdmitted(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitDestination[] {
	const facts = factsOfForm(doc, formUuid);
	if (facts === undefined) return ["app_home", "firstMenu"];
	const reasons = reasonsThatHold(facts);
	return destinationsLeft(
		formHoldsLinks(doc, formUuid)
			? reasons.filter((reason) => !MULTI_SELECT_REASONS.has(reason))
			: reasons,
	);
}

/**
 * The destinations a picker lists for `formUuid`: the offered set, plus a
 * stored destination the form's links keep admitted while the module no
 * longer offers it, so the picker can still show what is stored. In
 * `POST_SUBMIT_DESTINATIONS` order.
 */
export function postSubmitDestinationChoices(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitDestination[] {
	const offered = postSubmitDestinationsOffered(doc, formUuid);
	const stored = doc.forms[formUuid]?.postSubmit;
	if (stored === undefined || offered.includes(stored)) return offered;
	if (!postSubmitDestinationsAdmitted(doc, formUuid).includes(stored))
		return offered;
	return POST_SUBMIT_DESTINATIONS.filter(
		(destination) => offered.includes(destination) || destination === stored,
	);
}

/**
 * The first reason, in report order, that withholds `destination` from
 * `formUuid`, or `undefined` while the form may hold it. Reads the admitted
 * set, so a form with links is never refused a fallback for a several-case
 * reason.
 */
export function postSubmitNotOfferedReason(
	doc: PostSubmitDoc,
	formUuid: Uuid,
	destination: PostSubmitDestination,
): PostSubmitNotOfferedReason | undefined {
	const facts = factsOfForm(doc, formUuid);
	if (facts === undefined) return undefined;
	const exempt = formHoldsLinks(doc, formUuid);
	return reasonsThatHold(facts).find(
		(reason) =>
			!(exempt && MULTI_SELECT_REASONS.has(reason)) &&
			WITHHELD_BY[reason].includes(destination),
	);
}

/** The after-submit default of `formUuid`, given its type and module. */
export function defaultPostSubmitOf(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitDestination | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	return defaultPostSubmit(form.type, factsOfForm(doc, formUuid) ?? {});
}

/** Where `formUuid` goes after submit: its stored slot, else its default. */
export function effectivePostSubmit(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitDestination | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	return form.postSubmit ?? defaultPostSubmitOf(doc, formUuid);
}

function factsOfForm(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): PostSubmitModuleFacts | undefined {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	return moduleUuid === undefined
		? undefined
		: postSubmitModuleFacts(doc, moduleUuid);
}

function formHoldsLinks(doc: PostSubmitDoc, formUuid: Uuid): boolean {
	return (doc.forms[formUuid]?.formLinks?.length ?? 0) > 0;
}
