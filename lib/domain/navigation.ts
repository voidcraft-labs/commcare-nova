/** Navigation decisions shared by authoring reads and the running app. */
import type { BlueprintDoc } from "./blueprint";
import { CASE_LOADING_FORM_TYPES, type FormType } from "./forms";
import { moduleIsCaseFirst } from "./menuForms";
import { moduleOpensOnSearch } from "./modules";
import { effectivePostSubmit, moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

/** What the module URL should actually show. */
export type ModuleScreenLanding =
	/** Render the form menu. */
	| { readonly kind: "form-menu" }
	/** Bare case list: rewrite history so the empty module URL is not a stop. */
	| { readonly kind: "replace-with-case-list" }
	/** Case-first in the running app: push the case list over the menu. */
	| { readonly kind: "open-case-list" };

/**
 * Two module shapes make the form menu the wrong landing:
 *
 * - A `caseListOnly` module is a bare case list with no forms in any mode, so
 *   the menu is always empty. It REPLACES history, because `{kind:"module"}`
 *   must never become a back-button stop for a formless module.
 * - A case-first module (every form case-loading) lands on the case list in the
 *   running app, since the shared case selection hoists. Edit mode keeps the
 *   menu: it is the authoring surface, so this arm is preview-only, and it
 *   PUSHES, because the module is a real reachable screen while authoring.
 *
 * The bare-case-list arm wins when both apply: it holds in edit mode too, and
 * its history replacement is the stronger claim.
 */
export function moduleScreenLanding(args: {
	readonly hasModule: boolean;
	readonly preserveEntryPointMenu?: boolean;
	readonly hasChildren?: boolean;
	readonly hasSelectedCase?: boolean;
	readonly isBareCaseList: boolean;
	readonly isCaseFirst: boolean;
	readonly mode: "edit" | "preview";
}): ModuleScreenLanding {
	if (!args.hasModule || args.preserveEntryPointMenu)
		return { kind: "form-menu" };
	/* A parent module is a real menu even when its own case workflow would
	 * normally hoist selection. It must remain available to show child tiles. */
	if (args.hasChildren) return { kind: "form-menu" };
	if (args.isBareCaseList) return { kind: "replace-with-case-list" };
	if (args.mode !== "edit" && args.isCaseFirst && !args.hasSelectedCase)
		return { kind: "open-case-list" };
	return { kind: "form-menu" };
}

/** What clicking a form in the menu does. */
export type FormLaunch =
	/** Open the form directly: it loads no case. */
	| { readonly kind: "open-form" }
	/**
	 * Select a case first. The clicked form becomes the case list's continue
	 * target, so picking a case returns to THIS form rather than the module's
	 * first case-loading one.
	 */
	| { readonly kind: "select-case-first" };

/**
 * A case-loading form needs a case, but only if its module actually has a case
 * type: a case-loading form in a caseless module has no list to select from,
 * so it opens directly rather than routing to a list that cannot exist.
 */
export function formLaunch(args: {
	readonly formType: FormType;
	readonly moduleHasCaseType: boolean;
}): FormLaunch {
	return CASE_LOADING_FORM_TYPES.has(args.formType) && args.moduleHasCaseType
		? { kind: "select-case-first" }
		: { kind: "open-form" };
}

export type ModuleLanding = "case-list" | "form-menu";

/**
 * A bare case list (`caseListOnly`) has no form menu to show, and a
 * case-first module (every form case-loading) hoists the case selection in
 * the running app; both land on the case list. Everything else lands on the
 * form menu.
 */
export function moduleLanding(args: {
	readonly isCaseFirst: boolean;
	readonly isBareCaseList: boolean;
	readonly hasChildren?: boolean;
	readonly hasSelectedCase?: boolean;
}): ModuleLanding {
	const landing = moduleScreenLanding({
		hasModule: true,
		hasChildren: args.hasChildren,
		hasSelectedCase: args.hasSelectedCase,
		isBareCaseList: args.isBareCaseList,
		isCaseFirst: args.isCaseFirst,
		mode: "preview",
	});
	return landing.kind === "form-menu" ? "form-menu" : "case-list";
}

export type NavigationDestination =
	| { readonly screen: "home" | "previous" }
	| {
			readonly screen: "menu" | "results" | "search";
			readonly moduleUuid: Uuid;
			readonly name: string;
			/** A selected record changes a case-first menu's entry screen. */
			readonly withSelectedRecord?: "menu";
	  }
	| {
			readonly screen: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly name: string;
	  }
	| { readonly screen: "unavailable" };

type NavigationDoc = Pick<BlueprintDoc, "modules" | "forms" | "formOrder">;

/** An ordinary module entry, rather than an entry point that pins its menu.
 * Without a concrete session, preserve the selected-record alternative. */
export function moduleDestination(
	doc: NavigationDoc,
	moduleUuid: Uuid,
	hasSelectedRecord?: boolean,
): NavigationDestination {
	const mod = doc.modules[moduleUuid];
	if (!mod) return { screen: "unavailable" };
	const shape = {
		isCaseFirst: moduleIsCaseFirst(doc, moduleUuid),
		isBareCaseList: mod.caseListOnly === true,
		hasChildren: Object.values(doc.modules).some(
			(child) => child.parentModuleUuid === moduleUuid,
		),
	};
	const landing = moduleLanding({
		...shape,
		hasSelectedCase: hasSelectedRecord,
	});
	const changesWithSelection =
		hasSelectedRecord === undefined &&
		landing !== moduleLanding({ ...shape, hasSelectedCase: true });
	return {
		screen:
			landing === "form-menu"
				? "menu"
				: moduleOpensOnSearch(mod)
					? "search"
					: "results",
		moduleUuid,
		name: mod.name,
		...(changesWithSelection && { withSelectedRecord: "menu" as const }),
	};
}

/** Resolved destinations supplement configuration with its actual behavior.
 * Link conditions remain on the links; they are not repeated in this read. */
export function formNavigation(doc: NavigationDoc, formUuid: Uuid) {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (!form || !moduleUuid || !doc.modules[moduleUuid]) return undefined;
	const destination = effectivePostSubmit(doc, formUuid);
	const fallback: NavigationDestination =
		form.entry?.kind === "search-no-matches" && form.postSubmit === undefined
			? { screen: "results", moduleUuid, name: doc.modules[moduleUuid].name }
			: destination === "module"
				? moduleDestination(doc, moduleUuid)
				: { screen: destination === "previous" ? "previous" : "home" };
	return {
		recordSelection:
			form.entry?.kind === "search-no-matches"
				? ("no-matches" as const)
				: formLaunch({
							formType: form.type,
							moduleHasCaseType:
								doc.modules[moduleUuid]?.caseType !== undefined,
						}).kind === "select-case-first"
					? ("required" as const)
					: ("none" as const),
		afterSubmit: {
			fallback,
			links: (form.formLinks ?? []).map((link) => {
				const target = link.target;
				const linkedForm =
					target.type === "form" ? doc.forms[target.formUuid] : undefined;
				const destination: NavigationDestination =
					target.type === "module"
						? moduleDestination(doc, target.moduleUuid)
						: linkedForm &&
								(doc.formOrder[target.moduleUuid] ?? []).includes(
									target.formUuid,
								)
							? {
									screen: "form",
									moduleUuid: target.moduleUuid,
									formUuid: target.formUuid,
									name: linkedForm.name,
								}
							: { screen: "unavailable" };
				return { uuid: link.uuid, destination };
			}),
		},
	};
}
