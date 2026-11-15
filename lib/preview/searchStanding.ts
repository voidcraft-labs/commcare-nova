// lib/preview/searchStanding.ts
//
// When a search the worker ran still stands, and when the session lets it go.
//
// Web Apps keeps each search as query data on the page's address, recorded
// with the selections that led to its list (`cloudcare/js/formplayer/utils/
// utils.js::CloudcareUrl.setQueryData`), and every step forward carries the
// address's query data on (`addSelection` keeps it). A breadcrumb cuts the
// selections back to the screen it names and keeps only the queries recorded
// strictly before the cut (`spliceSelections`), so a crumb to the menu a list
// belongs to, or to any screen above it, drops that list's query, while the
// crumb of a case the list chose keeps it; Home drops every query
// (`clearExceptApp`), and so does the address a submission pushes
// (`onSubmit`, in `app.js`'s submit handler). Browser Back and Forward
// return to an address with the query data it was written with, its answers
// the ones the page keeps for that query (`CloudcareUrl.fromJson`,
// `Utils.getCurrentQueryInputs`), so a search stands again on every entry it
// stood on. Formplayer answers a query step from that data when it has it and runs
// the menu's default search when it has none
// (`MenuSessionRunnerService.java::handleQueryScreen`). Android holds the
// search as a step of its session frame: stepping back past the list pops it
// (`CommCareSession.java::stepBack`), the end of a form's frame drops it, and
// its home screen resets the whole session (`clearAllState`).
//
// Preview keeps each module's current search in the session store, and each
// browser history entry records which searches stand on it, with their
// contexts, so one the session has since replaced stands again there
// (`lib/routing/previewSearchHistory.ts`): a search stands on the entry it was
// begun on and on every entry a step forward pushes from one it stands on, and
// arriving on a screen lets go of every search whose list is not on the path to
// it. A crumb lets go as Web Apps' cut does; a submission lets every search
// go on the screen it lands on, the entries before it keeping theirs
// (`previewSearchHistory.ts::previewSearchHistoryWrite`); Home lets every
// search go from the session.

import type { Uuid } from "@/lib/doc/types";
import { moduleFormsReadSearch } from "@/lib/domain";
import {
	type ModuleHierarchySource,
	moduleParent,
} from "@/lib/domain/moduleHierarchy";
import type { Location } from "@/lib/routing/types";
import { submittedSearchOf } from "@/lib/session/previewSearchState";
import type {
	PreviewCaseListRegistrationEntry,
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewParentCaseRequest,
	PreviewSearchState,
} from "@/lib/session/types";

/**
 * A screen of the session, as the searches it keeps see it: the menu it is
 * on (none for the app's first screen), whether it is past that menu's own
 * list (`through`), and the lists past which it was reached from elsewhere
 * (`alsoPast`: a registration form the list's Register action opened, the
 * list that chose a form's case, a parent case being chosen for a menu).
 */
export interface PreviewSearchScreen {
	readonly moduleUuid: Uuid | undefined;
	readonly through?: boolean;
	readonly alsoPast?: readonly Uuid[];
}

/** The menus whose lists lie on the path to a screen: every menu above its
 *  menu, its menu where the screen is past its list, and each list it was
 *  reached past, with the menus above that. */
export function previewSearchPathModules(
	doc: ModuleHierarchySource,
	screen: PreviewSearchScreen,
): ReadonlySet<string> {
	const onPath = new Set<string>();
	const withAncestors = (start: Uuid, self: boolean) => {
		if (self) onPath.add(start);
		let current: Uuid | null | undefined = start;
		while (current !== undefined && current !== null) {
			current = moduleParent(doc, current);
			if (current !== undefined && current !== null) onPath.add(current);
		}
	};
	if (screen.moduleUuid !== undefined)
		withAncestors(screen.moduleUuid, screen.through === true);
	for (const past of screen.alsoPast ?? []) withAncestors(past, true);
	return onPath;
}

/** The running facts a screen was reached through, beside its location. */
export interface PreviewSearchScreenFacts {
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly caseTarget: PreviewCaseTarget | undefined;
	readonly registrationEntry: PreviewCaseListRegistrationEntry | undefined;
	readonly parentCaseRequest: PreviewParentCaseRequest | undefined;
}

/**
 * The screen the worker stands on at a running location. The first screen is
 * above every list. A menu screen is past its own list once the menu holds
 * its case, or where its forms read the search, whose menu lists them only
 * after its query has run. A list, a case's details and a form are past
 * their own menu's list and past every list they were reached through.
 * Undefined for a location no running screen shows.
 */
export function previewSearchScreenOf(
	doc: ModuleHierarchySource,
	loc: Location,
	facts: PreviewSearchScreenFacts,
): PreviewSearchScreen | undefined {
	if (loc.kind === "home") return { moduleUuid: undefined };
	if (loc.kind === "module") {
		const module = doc.modules[loc.moduleUuid];
		return {
			moduleUuid: loc.moduleUuid,
			through:
				facts.menuSelections[loc.moduleUuid] !== undefined ||
				(module !== undefined && moduleFormsReadSearch(module)),
		};
	}
	if (
		loc.kind !== "cases" &&
		loc.kind !== "search-config" &&
		loc.kind !== "detail-config" &&
		loc.kind !== "data-review" &&
		loc.kind !== "form"
	)
		return undefined;
	const alsoPast: Uuid[] = [];
	const request = facts.parentCaseRequest;
	if (request !== undefined) alsoPast.push(...request.returnModuleUuids);
	const entry = facts.registrationEntry;
	if (entry !== undefined) alsoPast.push(entry.hostModuleUuid);
	const target = facts.caseTarget;
	if (
		loc.kind === "form" &&
		target !== undefined &&
		target.formUuid === loc.formUuid
	) {
		if (target.searchLaunch !== undefined)
			alsoPast.push(target.searchLaunch.moduleUuid);
		if (target.formChosenAfterCase !== undefined)
			alsoPast.push(target.formChosenAfterCase.caseListModuleUuid);
	}
	return { moduleUuid: loc.moduleUuid, through: true, alsoPast };
}

/** The search a module's list holds on the current history entry: its
 *  context in the session, where that search stands on the entry. */
export function previewStandingSearch(
	state: PreviewSearchState | undefined,
	standing: ReadonlySet<string>,
): Exclude<PreviewSearchState, { kind: "not-searched" }> | undefined {
	return state !== undefined &&
		state.kind !== "not-searched" &&
		standing.has(state.submission)
		? state
		: undefined;
}

/**
 * The searches that still stand once the worker is on `screen`: of those
 * standing on the entry, each whose list lies on the path to the screen.
 */
export function previewSearchesStandingAt(
	doc: ModuleHierarchySource,
	states: Readonly<Record<string, PreviewSearchState>>,
	standing: ReadonlySet<string>,
	screen: PreviewSearchScreen,
): string[] {
	const onPath = previewSearchPathModules(doc, screen);
	const kept: string[] = [];
	for (const [moduleUuid, state] of Object.entries(states)) {
		const stands = previewStandingSearch(state, standing);
		if (stands !== undefined && onPath.has(moduleUuid))
			kept.push(stands.submission);
	}
	return kept;
}

/**
 * How a list's own search run follows its module's search where that search
 * stands on the screen on show. The run is the screen's (its draft, its
 * submitted answers); the module's search is the session's, and only the
 * session and the history entry know when a search stands. So the run follows
 * it on every list with a search, whether its menu's forms read the search or
 * a Search action runs it, as Web Apps keeps every query on the page's
 * address alike (`utils.js::CloudcareUrl.setQueryData`) and lets each go by
 * the same cut, submission and Home:
 *
 * - `restore`: a search stands that the run does not hold (a list built
 *   afresh, or one Preview only hid that history returns to where the search
 *   stands again), so the run takes it back with the worker's answers, as Web
 *   Apps restores the address's query data (`CloudcareUrl.fromJson`) and
 *   Formplayer answers the prompts from it before it runs the query
 *   (`MenuSessionRunnerService.java::handleQueryScreen`);
 * - `retire`: the run held the standing search and dropped it on its own
 *   (the last prompt removed), which lets the module's search go;
 * - `clear`: no search stands (a crumb above the list, a submission, Home,
 *   a step back past it), so the run the screen still holds goes and the
 *   menu opens on its default search, or on its list, again;
 * - `keep`: the two agree.
 *
 * `held` is the submission the run last took (its own Search press or a
 * restore), and none once it was cleared. A Search screen asked for again
 * (`manual`) holds no answers, so it is no submitted search here.
 */
export function previewSearchRunFollows(args: {
	/** The module's search where it stands on the screen on show. */
	readonly standing: PreviewSearchState | undefined;
	/** The screen's run holds a submitted search. */
	readonly hasSubmitted: boolean;
	/** The submission the run last took, none once it was cleared. */
	readonly held: string | undefined;
}): "restore" | "retire" | "clear" | "keep" {
	const submitted = submittedSearchOf(args.standing);
	if (submitted === undefined) return args.hasSubmitted ? "clear" : "keep";
	if (args.held !== submitted.submission) return "restore";
	return args.hasSubmitted ? "keep" : "retire";
}

/**
 * Whether the list shows its Search screen where it would otherwise run its
 * default search: the worker pressed Search again and has not searched since,
 * and that request still stands. Web Apps carries it as `force_manual_search`
 * in the address's query data (`utils.js::CloudcareUrl.setQueryData`, set by
 * Search again), which a crumb, Home, a submission and a new session drop,
 * and Formplayer then runs the default search
 * (`MenuSessionRunnerService.java::handleQueryScreen`: `autoSearch` is
 * `doDefaultSearch() && !forceManualSearch`).
 */
export function previewSearchReopened(
	standing: PreviewSearchState | undefined,
	hasSubmitted: boolean,
): boolean {
	return standing?.kind === "manual" && !hasSubmitted;
}
