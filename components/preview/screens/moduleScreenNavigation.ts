/**
 * The module screen's two navigation decisions, as pure functions.
 *
 * Both are `f(module shape, mode)` with no React and no DOM, which is what lets
 * them be checked directly. The component reads them and performs the effect;
 * the rules themselves: when a form menu is the wrong landing, and whether a
 * form needs a case before it can open: live here.
 */

import { CASE_LOADING_FORM_TYPES, type FormType } from "@/lib/domain";

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
	readonly hasChildren?: boolean;
	readonly hasSelectedCase?: boolean;
	readonly isBareCaseList: boolean;
	readonly isCaseFirst: boolean;
	readonly mode: "edit" | "preview";
}): ModuleScreenLanding {
	if (!args.hasModule) return { kind: "form-menu" };
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
