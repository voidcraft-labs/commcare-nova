/**
 * The case tile a running screen pins above itself. CommCare pins one tile on
 * every screen of a session that holds a chosen case whose list asks to keep
 * its tile on screen, and the screens that draw it differ by platform:
 *
 * - Web Apps: Formplayer sets the tile on every response it builds, a menu, a
 *   case list or a search included (`MenuSessionRunnerService.getNextMenu`,
 *   `setPersistentCaseTile`, and `startFormEntry` for a form), and HQ's client
 *   draws whatever tile the response carries (`menus/controller.js::showMenu`,
 *   `showPersistentCaseTile`).
 * - Android: `BreadcrumbBarHelper.attachBreadcrumbBar` loads the tile for every
 *   activity and places it where the activity's layout holds
 *   `universal_frame_tile`, which a menu (`screen_suite_menu.xml`,
 *   `grid_menu_layout.xml`), a case list (`entity_select_layout.xml`), a case's
 *   details (`entity_detail.xml`) and a form (`screen_form_entry.xml`) hold and
 *   the search screen (`QueryRequestUiController`, `http_request_layout.xml`)
 *   does not.
 *
 * Which case: both read the session's steps the same way
 * (`MenuSessionRunnerService.getStepToFrame`, `BreadcrumbBarHelper.loadTile`),
 * walking back from the latest step and keeping the last match, so the tile is
 * the EARLIEST chosen case whose datum names a persistent detail. Nova's wire
 * gives a datum the persistent detail exactly where the list that chose it
 * keeps its tile on screen (`compiler.ts`, `formLinkProjection.ts`, the
 * `persistOnForms` arms), and a datum that holds several cases is another kind
 * of step, which neither reads.
 */
import type { Module, Uuid } from "@/lib/domain";
import type { PreviewHeldCaseSelection } from "./menuProjection";
import type { PreviewPlatformRules } from "./platform";

/** The case a screen pins, and the module whose case list draws its tile. */
export interface PreviewPinnedCaseTile {
	readonly moduleUuid: Uuid;
	/** Blank where the session holds a case it bound to nothing, which the
	 *  device draws no tile for (`buildContextTile`'s null reference). */
	readonly caseId: string;
}

/** The running screens that can carry the tile. */
export type PinnedTileSurface = "menu" | "case-list" | "search" | "form";

/**
 * The tile a screen of this session pins, or none: the earliest held case
 * whose list keeps its tile on screen, on a screen the platform draws it on.
 * `held` is in the order the session chose the cases
 * (`menuProjection.ts::previewMenuHeldSelections`).
 */
export function previewPinnedCaseTile(
	modules: Readonly<Record<string, Module | undefined>>,
	held: readonly PreviewHeldCaseSelection[],
	surface: PinnedTileSurface,
	rules: Pick<PreviewPlatformRules, "searchScreenCaseTile">,
): PreviewPinnedCaseTile | undefined {
	if (surface === "search" && !rules.searchScreenCaseTile) return undefined;
	for (const selection of held) {
		const [only, ...more] = selection.cases;
		if (only === undefined || more.length > 0) continue;
		if (
			modules[selection.moduleUuid]?.caseListConfig?.tile?.persistOnForms !==
			true
		)
			continue;
		return { moduleUuid: selection.moduleUuid, caseId: only.caseId };
	}
	return undefined;
}
