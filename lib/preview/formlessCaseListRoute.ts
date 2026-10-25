// lib/preview/formlessCaseListRoute.ts
//
// Where choosing a case lands in a module with a case list and no forms (the
// case list menu item, `caseListOnly`). Both runtimes end the session there,
// since nothing follows the selection: Formplayer
// (`services/MenuSessionRunnerService.java::advanceSessionWithSelections` →
// `resolveFormGetNext` null) posts "Redirecting after sync", clears the
// session, and the client returns to the app's first screen
// (`formplayer/menus/controller.js::selectMenu` → `apps:currentApp`); Android
// (`HomeScreenBaseActivity.java::handleNoFormFromSessionNav` →
// `terminateSession`) returns to its home screen. Pure: the running case list
// and App Tests both route by it.

import type { PreviewPlatformRules } from "./platform";

export type FormlessCaseListRoute =
	/** The app's first screen, with Web Apps' sync notice (runtime message
	 *  `formlessReturned`). */
	| { readonly kind: "root-menu"; readonly notice: "formlessReturned" }
	/** The phone's home screen. */
	| { readonly kind: "device-home" };

export function formlessCaseListSelection(
	rules: Pick<PreviewPlatformRules, "formlessCaseListSelection">,
): FormlessCaseListRoute {
	return rules.formlessCaseListSelection === "device-home"
		? { kind: "device-home" }
		: { kind: "root-menu", notice: "formlessReturned" };
}
