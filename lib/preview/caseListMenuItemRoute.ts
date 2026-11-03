// lib/preview/caseListMenuItemRoute.ts
//
// Where choosing a case lands when the case list was opened from a module's
// case list menu entry (`caseListMenuItem`), formless or beside forms. The
// entry is a view command: it holds no form, so nothing follows the choice.
// Formplayer steps the session back over the datum and asks for the next
// screen again (`session/MenuSession.java::getNextScreen`, `isViewCommand` →
// `stepBack`), so the screen before the choice shows: the case list with
// nothing chosen in a forms-first menu, the menu in a case-first one.
// Android, with no case detail, ends the session at its home screen
// (`EntitySelectActivity.java::onEntitySelected` → `returnWithResult`;
// `HomeScreenBaseActivity.java::handleNoFormFromSessionNav` →
// `terminateSession`); with a case detail it shows the detail in view mode
// with Done (`EntityDetailActivity.java`, `select.detail.bypass`), whose
// result leaves the list showing (`EntitySelectActivity.java::onActivityResult`
// with `mViewMode`). Pure: the running case list and App Tests both route by
// it.

import type { PreviewPlatformRules } from "./platform";

export type CaseListMenuItemRoute =
	/** The screen before the choice, as Back would show it. */
	| { readonly kind: "step-back" }
	/** The phone's home screen. */
	| { readonly kind: "device-home" };

export function caseListMenuItemSelection(
	rules: Pick<PreviewPlatformRules, "caseListMenuItemSelection">,
): CaseListMenuItemRoute {
	return rules.caseListMenuItemSelection === "device-home"
		? { kind: "device-home" }
		: { kind: "step-back" };
}

/** What a chosen case's detail does when the list was opened from a case
 *  list menu entry. `continue` takes the selection route after the detail's
 *  Continue; `return-to-list` is Android's Done, which goes back to the list
 *  with nothing chosen. A list with no Details columns shows no detail and
 *  takes the route at once. */
export type CaseListMenuItemDetailAction =
	| { readonly kind: "continue"; readonly message: "continue" }
	| { readonly kind: "return-to-list"; readonly message: "detailDone" };

export function caseListMenuItemDetailAction(
	rules: Pick<PreviewPlatformRules, "caseListMenuItemDetail">,
): CaseListMenuItemDetailAction {
	return rules.caseListMenuItemDetail === "done"
		? { kind: "return-to-list", message: "detailDone" }
		: { kind: "continue", message: "continue" };
}
