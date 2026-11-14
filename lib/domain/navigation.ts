/** Navigation decisions shared by authoring reads and the running app. */
import { resolveFormLinkTarget } from "./formLinkTargets";
import {
	CASE_LOADING_FORM_TYPES,
	type FormLinkTarget,
	type FormType,
	type PostSubmitDestination,
} from "./forms";
import { afterEmptySearchRegistrationFormOf } from "./menuForms";
import {
	type MenuScreenSource,
	moduleHasOwnScreen,
	screenChoosesCaseFirst,
	screenIsBareCaseList,
} from "./menuScreens";
import { moduleSearchWorkflow } from "./modules";
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
 * - A bare case list (`menuForms.ts::moduleIsBareCaseList`: a case list menu
 *   entry and no menu forms) has no forms in any mode, so the menu is always
 *   empty. It REPLACES history, because `{kind:"module"}`
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
 * A bare case list (`moduleIsBareCaseList`) has no form menu to show, and a
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

/** Known construction findings that prevent a private task from resolving. */
export interface NavigationReadFinding {
	readonly code: string;
	readonly message: string;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly fieldUuid?: Uuid;
}

export type NavigationDestination =
	| { readonly screen: "home" }
	| {
			readonly screen: "record-selection";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly selectingModuleUuids: readonly Uuid[];
			readonly name: string;
	  }
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
	| {
			readonly screen: "unavailable";
			readonly reason?: string;
			readonly findings?: readonly NavigationReadFinding[];
	  };

type NavigationDoc = MenuScreenSource;

/** An ordinary module entry, rather than an entry point that pins its menu.
 * Without a concrete session, preserve the selected-record alternative. A
 * module that shows its forms in the menu above has no screen to land on.
 * Case first and the bare case list are facts of the module's own screen,
 * which lists the forms of any submenu that shows its forms there. */
export function moduleDestination(
	doc: NavigationDoc,
	moduleUuid: Uuid,
	hasSelectedRecord?: boolean,
): NavigationDestination {
	const mod = doc.modules[moduleUuid];
	if (!mod || !moduleHasOwnScreen(doc, moduleUuid))
		return { screen: "unavailable" };
	const screen = { kind: "menu", moduleUuid } as const;
	const shape = {
		isCaseFirst: screenChoosesCaseFirst(doc, screen),
		isBareCaseList: screenIsBareCaseList(doc, screen),
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
				: moduleSearchWorkflow(mod) === "searchFirst"
					? "search"
					: "results",
		moduleUuid,
		name: mod.name,
		...(changesWithSelection && { withSelectedRecord: "menu" as const }),
	};
}

/** The parent module's screen, reached with its selection kept. A module
 * with no parent has none, which the gate refuses as a destination. */
export function parentMenuDestination(
	doc: NavigationDoc,
	moduleUuid: Uuid,
): NavigationDestination {
	const parentUuid = doc.modules[moduleUuid]?.parentModuleUuid;
	return parentUuid === undefined
		? { screen: "unavailable" }
		: moduleDestination(doc, parentUuid);
}

/** A form's after-submit, as each surface reads where it lands. */
export interface FormAfterSubmitNavigation {
	/** In author order. */
	readonly destinations: readonly {
		readonly uuid: Uuid;
		readonly destination: NavigationDestination;
	}[];
	readonly otherwise: NavigationDestination | undefined;
	/** A form without destinations: its after-submit. */
	readonly postSubmit: NavigationDestination | undefined;
}

/** Where a built-in after-submit destination word lands. */
function builtInDestination(
	doc: NavigationDoc,
	moduleUuid: Uuid,
	destination: PostSubmitDestination | undefined,
	previousDestination: NavigationDestination | undefined,
): NavigationDestination {
	switch (destination) {
		case "module":
			return moduleDestination(doc, moduleUuid);
		case "parentMenu":
			return parentMenuDestination(doc, moduleUuid);
		case "previous":
			return previousDestination ?? { screen: "unavailable" };
		default:
			// `app_home` and `firstMenu` share one home screen until Preview
			// plays each platform: Web Apps shows the app's first screen for
			// both.
			return { screen: "home" };
	}
}

/** Where a link lands: `this-form` is the source form in its own menu. */
function linkDestination(
	doc: NavigationDoc,
	formUuid: Uuid,
	target: FormLinkTarget,
): NavigationDestination {
	const resolved = resolveFormLinkTarget(doc, formUuid, target);
	if (resolved === undefined) return { screen: "unavailable" };
	if (resolved.type === "module")
		return moduleDestination(doc, resolved.moduleUuid);
	const linkedForm = doc.forms[resolved.formUuid];
	return linkedForm &&
		(doc.formOrder[resolved.moduleUuid] ?? []).includes(resolved.formUuid)
		? {
				screen: "form",
				moduleUuid: resolved.moduleUuid,
				formUuid: resolved.formUuid,
				name: linkedForm.name,
			}
		: { screen: "unavailable" };
}

/** Resolved destinations supplement configuration with its actual behavior.
 * Link conditions remain on the links; they are not repeated in this read.
 * A form with destinations reads them in author order with its otherwise;
 * a form without them reads its after-submit (`postSubmit`). */
export function formNavigation(
	doc: NavigationDoc,
	formUuid: Uuid,
	previousDestination?: NavigationDestination,
) {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (!form || !moduleUuid || !doc.modules[moduleUuid]) return undefined;
	const registersFromCaseList =
		afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid;
	const hasDestinations = form.formLinks !== undefined;
	const postSubmit: NavigationDestination | undefined = hasDestinations
		? undefined
		: registersFromCaseList && form.postSubmit === undefined
			? { screen: "results", moduleUuid, name: doc.modules[moduleUuid].name }
			: builtInDestination(
					doc,
					moduleUuid,
					effectivePostSubmit(doc, formUuid),
					previousDestination,
				);
	const otherwise: NavigationDestination | undefined =
		form.otherwise === undefined
			? undefined
			: form.otherwise.kind === "destination"
				? builtInDestination(
						doc,
						moduleUuid,
						form.otherwise.destination,
						previousDestination,
					)
				: linkDestination(doc, formUuid, form.otherwise.target);
	return {
		recordSelection: registersFromCaseList
			? ("no-matches" as const)
			: formLaunch({
						formType: form.type,
						moduleHasCaseType: doc.modules[moduleUuid]?.caseType !== undefined,
					}).kind === "select-case-first"
				? ("required" as const)
				: ("none" as const),
		afterSubmit: {
			destinations: (form.formLinks ?? []).map((link) => ({
				uuid: link.uuid,
				destination: linkDestination(doc, formUuid, link.target),
			})),
			otherwise,
			postSubmit,
		} satisfies FormAfterSubmitNavigation as FormAfterSubmitNavigation,
	};
}
