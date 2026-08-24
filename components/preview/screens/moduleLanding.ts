/**
 * Where entering a module lands in the running app, and how to go there.
 *
 * The home screen's module tiles and a form's after-submit link to a module
 * both ENTER a module from outside it, and they must land on the same screen:
 * `moduleScreenLanding` (the rule the module URL itself applies) already says
 * which module shapes make the form menu the wrong stop, so this is that rule
 * read from the outside, collapsed to the one question an entry asks: case
 * list or form menu.
 */

import type { Uuid } from "@/lib/domain";
import type { NavigateActions } from "@/lib/routing/hooks";
import { moduleScreenLanding } from "./moduleScreenNavigation";

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

/** Push the module's landing screen. */
export function openModuleLanding(
	navigate: Pick<NavigateActions, "openCaseList" | "openModule">,
	moduleUuid: Uuid,
	landing: ModuleLanding,
): void {
	if (landing === "case-list") navigate.openCaseList(moduleUuid);
	else navigate.openModule(moduleUuid);
}
