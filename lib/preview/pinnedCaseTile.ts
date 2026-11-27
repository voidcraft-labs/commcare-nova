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
 *
 * Android's case details add one more: where the frame names no case, the
 * details screen draws the case it shows, with the persistent detail of the
 * datum the list is choosing for (`BreadcrumbBarHelper.loadTile` falling back
 * to `EntityDetailActivity.requestEntityContext`, the detail
 * `EntityDetailUtils.populateDetailIntent` passes as `DETAIL_PERSISTENT_ID`
 * beside the datum's details screen). So the tile shows there where the list
 * keeps its tile on screen and is choosing its own case; a search action's
 * results choose for the remote request's datum, which names none
 * (`PreviewViewedDatum`). Formplayer's details answer carries no tile
 * (`MenuController.getDetails`).
 */

import { type Module, moduleFormsReadSearch, type Uuid } from "@/lib/domain";
import { resolveCaseFormContext } from "@/lib/domain/caseFormContext";
import type {
	PreviewSearchAnswers,
	PreviewSearchState,
} from "@/lib/session/types";
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
export type PinnedTileSurface =
	| "menu"
	| "case-list"
	| "case-details"
	| "search"
	| "form";

/**
 * The datum a case's details choose for, which decides the persistent detail
 * Android's details read (`EntityDetailUtils.populateDetailIntent`):
 *
 * - `list`: the list's own datum, a browse list's or the results of a search
 *   its forms read, which names `m<index>_case_short` where the list keeps
 *   its tile on screen (`formLinkProjection.ts`, the `persistOnForms` arms).
 * - `search-results`: the results of a search action, chosen for its remote
 *   request's `search_case_id`, which names a details screen and no
 *   persistent detail (`searchSession.ts::buildSearchSession`, as HQ writes
 *   it in `remote_requests.py`).
 * - `parent`: a parent case another list asked for, whose datum names no
 *   details screen (`formLinkProjection.ts` gives `detail-confirm` only to a
 *   list's own case), so Android opens none and passes no persistent detail.
 */
export type PreviewViewedDatum = "list" | "search-results" | "parent";

/** The case a case's details show, on the list of `moduleUuid`, and the
 *  datum the list is choosing it for. */
export interface PreviewViewedCase {
	readonly moduleUuid: Uuid;
	readonly caseId: string;
	readonly datum: PreviewViewedDatum;
}

/**
 * The tile a screen of this session pins, or none: the earliest held case
 * whose list keeps its tile on screen, on a screen the platform draws it on.
 * `held` is in the order the session chose the cases
 * (`menuProjection.ts::previewMenuHeldSelections`). On a case's details,
 * `viewing` is the case they show, which the session does not hold yet: a
 * platform that draws it does so where no held case pins a tile and the datum
 * being chosen names the list's persistent detail, its list's own datum where
 * that list keeps its tile on screen.
 */
export function previewPinnedCaseTile(
	modules: Readonly<Record<string, Module | undefined>>,
	held: readonly PreviewHeldCaseSelection[],
	surface: PinnedTileSurface,
	rules: Pick<
		PreviewPlatformRules,
		"searchScreenCaseTile" | "caseDetailsCaseTile"
	>,
	viewing?: PreviewViewedCase,
): PreviewPinnedCaseTile | undefined {
	if (surface === "search" && !rules.searchScreenCaseTile) return undefined;
	for (const selection of held) {
		const [only, ...more] = selection.cases;
		if (only === undefined || more.length > 0) continue;
		if (!keepsTileOnScreen(modules, selection.moduleUuid)) continue;
		return { moduleUuid: selection.moduleUuid, caseId: only.caseId };
	}
	if (
		surface === "case-details" &&
		rules.caseDetailsCaseTile &&
		viewing?.datum === "list" &&
		keepsTileOnScreen(modules, viewing.moduleUuid)
	)
		return { moduleUuid: viewing.moduleUuid, caseId: viewing.caseId };
	return undefined;
}

/** Whether a module's list keeps its tile on screen, which Nova's wire
 *  writes as the persistent detail of every datum that list chooses. */
function keepsTileOnScreen(
	modules: Readonly<Record<string, Module | undefined>>,
	moduleUuid: Uuid,
): boolean {
	return resolveCaseFormContext(modules, moduleUuid) !== undefined;
}

/** How the pinned tile reads its case: from the search that found it, with
 *  that search's answers, or from the worker's device (`undefined`). */
export interface PinnedTileSearchReading {
	readonly answers: PreviewSearchAnswers;
}

/**
 * Where the pinned tile reads its case. A list whose forms read the search
 * (CommCare's inline search) chooses every case from that search's results:
 * each case-loading datum of its entries reads `results:inline`
 * (`lib/commcare/compiler.ts`), and Formplayer draws the tile from the datum's
 * own nodeset (`MenuSessionRunnerService.getPersistentDetail` →
 * `entityDatum.getEntityFromID`). So while the list's search stands, the tile
 * reads the case as that search found it, a case the device does not hold yet
 * included, since such a menu's claim posts only as a form opens. Any other
 * list's case is the device's: a search action's claim lands before its
 * choice goes on (`CaseListScreen`'s `claimsAtResult`).
 */
export function pinnedTileSearchReading(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig"> | undefined,
	search: PreviewSearchState | undefined,
): PinnedTileSearchReading | undefined {
	if (module === undefined || !moduleFormsReadSearch(module)) return undefined;
	if (search?.kind !== "completed") return undefined;
	return { answers: search.answers };
}
