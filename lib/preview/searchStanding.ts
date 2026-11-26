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
// browser history entry names which searches stand on it, the session keeping
// their contexts in the entry's record, so one the session has since replaced
// stands again there (`lib/routing/previewSearchHistory.ts`): a search stands on the entry it was
// begun on and on every entry a step forward pushes from one it stands on, and
// arriving on a screen lets go of every search whose list is not on the path to
// it. A crumb lets go as Web Apps' cut does; a submission lets every search
// go on the screen it lands on, the entries before it keeping theirs
// (`previewSearchHistory.ts::previewSearchHistoryWrite`); Home lets every
// search go from the session.

import type { Uuid } from "@/lib/doc/types";
import { moduleFormsReadSearch } from "@/lib/domain";
import type { ModuleHierarchySource } from "@/lib/domain/moduleHierarchy";
import { searchPromptKeys } from "@/lib/preview/engine/searchRunState";
import {
	type PreviewSessionSource,
	previewMenuHeldSelections,
	previewSelectionsBeforeCommand,
} from "@/lib/preview/menuProjection";
import {
	previewSearchesOnEntry,
	type RecordedPreviewSearch,
} from "@/lib/routing/previewSearchHistory";
import type { Location } from "@/lib/routing/types";
import {
	searchRunPastItsList,
	searchWithLatestInputs,
	submittedSearchKey,
	submittedSearchOf,
} from "@/lib/session/previewSearchState";
import type {
	PreviewCaseListRegistrationEntry,
	PreviewCaseTarget,
	PreviewMenuCaseSelection,
	PreviewParentCaseRequest,
	PreviewSearchAnswers,
	PreviewSearchState,
} from "@/lib/session/types";
import type { PreviewPlatformRules } from "./platform";

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
	/** The module whose case list the screen shows, which runs that
	 *  module's query and settles it (`previewSearchArrival`). */
	readonly listShown?: Uuid;
}

/**
 * The menus whose lists lie on the path to a screen: the lists whose cases
 * the session held as the screen's menu's command was chosen
 * (`menuProjection.ts::previewSelectionsBeforeCommand`), its menu's own list
 * and every case its menu holds where the screen is past that list
 * (`previewMenuHeldSelections`), and each list it was reached past, with the
 * cases its menu holds. A structural menu above is on the path only where it
 * chose its case before the command: a forms-first menu's list that chose a
 * submenu's parent case did so after the submenu's command, so the
 * submenu's own menu screen is above that search, as Web Apps' crumb keeps
 * only the queries recorded strictly before the step it cuts to
 * (`utils.js::CloudcareUrl.spliceSelections`).
 */
export function previewSearchPathModules(
	source: PreviewSessionSource,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
	screen: PreviewSearchScreen,
): ReadonlySet<string> {
	const onPath = new Set<string>();
	const menu = screen.moduleUuid;
	if (menu !== undefined) {
		if (screen.through === true) onPath.add(menu);
		const held =
			screen.through === true
				? previewMenuHeldSelections(source, menu, selections)
				: previewSelectionsBeforeCommand(source, menu, selections);
		for (const selection of held) onPath.add(selection.moduleUuid);
	}
	for (const past of screen.alsoPast ?? []) {
		onPath.add(past);
		for (const selection of previewMenuHeldSelections(source, past, selections))
			onPath.add(selection.moduleUuid);
	}
	return onPath;
}

/** The running facts a screen was reached through, beside its location. */
export interface PreviewSearchScreenFacts {
	readonly menuSelections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly caseTarget: PreviewCaseTarget | undefined;
	readonly registrationEntry: PreviewCaseListRegistrationEntry | undefined;
	readonly parentCaseRequest: PreviewParentCaseRequest | undefined;
	/** The module whose case list the running screen shows, as the shell
	 *  projects the location (`usePreviewScreenForLocation`): none where it
	 *  shows a menu, a form or Home, a list location that lands elsewhere
	 *  included. */
	readonly listShown: Uuid | undefined;
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
	return {
		moduleUuid: loc.moduleUuid,
		through: true,
		alsoPast,
		...(loc.kind !== "form" &&
			facts.listShown === loc.moduleUuid && { listShown: loc.moduleUuid }),
	};
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
 * standing on the entry, each whose list lies on the path to the screen
 * (`previewSearchPathModules`).
 */
export function previewSearchesStandingAt(
	source: PreviewSessionSource,
	states: Readonly<Record<string, PreviewSearchState>>,
	standing: ReadonlySet<string>,
	screen: PreviewSearchScreen,
	/** The cases the session holds once the worker is on the screen (after
	 *  a crumb's cut, the cases it keeps). */
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): string[] {
	const onPath = previewSearchPathModules(source, selections, screen);
	const kept: string[] = [];
	for (const [moduleUuid, state] of Object.entries(states)) {
		const stands = previewStandingSearch(state, standing);
		if (stands !== undefined && onPath.has(moduleUuid))
			kept.push(stands.submission);
	}
	return kept;
}

/**
 * What answers a search history gives back runs with. Web Apps answers the
 * query an address records with the answers the worker last gave that query,
 * whichever search they were given for (`latest-answers`,
 * `previewSearchState.ts::searchWithLatestInputs`). Android has no addresses:
 * a search is a step of the session's frame, which keeps the very query it
 * ran (`CommCareSession.setQueryDatum` pushes a query step holding its
 * results' source, the request as sent), and a step back off a later screen
 * reaches that step as it was (`own-answers`). The platform's rule is
 * `platform.ts::PreviewPlatformRules.searchReplay`.
 */
export type PreviewSearchReplay = "latest-answers" | "own-answers";

/**
 * Arriving on a running screen, by a step forward or by Back and Forward:
 * which of the searches recorded on the entry still stand there (those on
 * the path to the screen, `previewSearchesStandingAt`), and each module's
 * search the session holds from now on where it differs from the one it
 * holds: a search the session has since replaced stands again with the
 * context the entry recorded (`previewSearchHistory.ts::previewSearchesOnEntry`),
 * and on Web Apps every search that stands there runs with the answers the
 * worker last gave its query (`replay`), as Formplayer replays the whole
 * address on every request (`MenuSessionRunnerService.advanceSessionWithSelections`)
 * and runs each query step on it with them.
 *
 * The list the screen shows runs its own again (`searchWithLatestInputs`):
 * it is the screen that runs the query and settles it (`CaseListScreen`). A
 * search standing on a menu, a form or another list past its list is run
 * there with them (`searchRunPastItsList`): it stays completed, so a form that
 * reads it reads the new run's results rather than waiting on a list that is
 * not on show, and the list counts it again as it comes on show. The case the
 * list chose stands, as Formplayer holds the selections confirmed
 * (`RestoreFactory.isConfirmedSelection`) until a submission's commit
 * (`RestoreFactory.commit`); past that commit Formplayer looks the case up in
 * the new results and fails the step where they lack it
 * (`EntityScreen.setSelectedEntity`), which Preview does not play.
 *
 * And only as the worker arrives (`moved`): the entry's own record rewritten
 * in place (the list settling its search writes its context there) runs the
 * hook again on the same screen, which is no step, and a field the worker
 * changed since without pressing Search runs nothing on Web Apps.
 */
export function previewSearchArrival(args: {
	readonly source: PreviewSessionSource;
	readonly screen: PreviewSearchScreen;
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
	/** The session's searches, by module. */
	readonly states: Readonly<Record<string, PreviewSearchState>>;
	/** The searches the entry records as standing on it. */
	readonly standing: readonly string[];
	/** The contexts the entry's record holds in the running Preview session. */
	readonly contexts: Readonly<Record<string, RecordedPreviewSearch>>;
	readonly replay: PreviewSearchReplay;
	/** The worker moved here (a step, Back or Forward), rather than the
	 *  entry's record being rewritten on the screen they are on. */
	readonly moved: boolean;
	/** The answers the worker last gave each module's query in this session. */
	readonly latest: Readonly<Record<string, PreviewSearchAnswers>>;
}): {
	readonly standing: string[];
	readonly searches: Readonly<Record<string, PreviewSearchState>>;
} {
	const recorded = new Set(args.standing);
	const held = previewSearchesOnEntry(args.states, recorded, args.contexts);
	const kept = new Set(
		previewSearchesStandingAt(
			args.source,
			held,
			recorded,
			args.screen,
			args.selections,
		),
	);
	const doc = "doc" in args.source ? args.source.doc : args.source;
	const searches: Record<string, PreviewSearchState> = {};
	for (const [moduleUuid, search] of Object.entries(held)) {
		if (search.kind === "not-searched" || !kept.has(search.submission))
			continue;
		const promptKeys = searchPromptKeys(
			doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [],
		);
		const replayed =
			args.replay !== "latest-answers" || !args.moved
				? search
				: args.screen.listShown === moduleUuid
					? searchWithLatestInputs(search, args.latest[moduleUuid], promptKeys)
					: searchRunPastItsList(search, args.latest[moduleUuid], promptKeys);
		if (replayed !== args.states[moduleUuid]) searches[moduleUuid] = replayed;
	}
	return {
		standing: args.standing.filter((submission) => kept.has(submission)),
		searches,
	};
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
 * `held` is what the run last took (its own Search press or a restore),
 * `previewSearchState.ts::submittedSearchKey` of it: the search and the
 * answers it ran with, so a search history gives back with other answers
 * (`searchWithLatestInputs`) is taken again. None once the run was cleared.
 * A Search screen asked for again (`manual`) holds no answers, so it is no
 * submitted search here.
 */
export function previewSearchRunFollows(args: {
	/** The module's search where it stands on the screen on show. */
	readonly standing: PreviewSearchState | undefined;
	/** The screen's run holds a submitted search. */
	readonly hasSubmitted: boolean;
	/** What the run last took, none once it was cleared. */
	readonly held: string | undefined;
}): "restore" | "retire" | "clear" | "keep" {
	const submitted = submittedSearchOf(args.standing);
	if (submitted === undefined) return args.hasSubmitted ? "clear" : "keep";
	if (args.held !== submittedSearchKey(submitted)) return "restore";
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

/**
 * The module's search once the worker presses Clear on its Search pane: the
 * answers typed go, and with them a search the pane's list holds, so a later
 * Results is a new attempt; a Search screen asked for again stays asked for.
 * Web Apps' Clear empties each field and changes nothing else
 * (`menus/views/query.js::QueryListView.clearAction` calls each
 * `QueryView.clear`, which sets the field's value and re-renders, firing no
 * field change, so no validation round trip writes the page's query inputs and
 * the address keeps its `force_manual_search`): the query screen stays on
 * show rather than the menu running its default search. A menu with
 * `searchOnClear` searches again after Clear where `searchAfterClear` says the
 * platform does; that quiet submit is the Search pane's, not this state's.
 */
export function previewSearchAfterClear(
	standing: PreviewSearchState | undefined,
): PreviewSearchState | undefined {
	return standing?.kind === "manual" ? standing : undefined;
}

/**
 * Whether the Search pane offers Clear: where the platform's search screen
 * has one (`platform.ts::PreviewPlatformRules.searchClear`, Web Apps' query
 * screen and never Android's) and there is something to clear, answers typed
 * or a search the pane's list holds. Android's screen holds no control that
 * empties its fields, so a search that found nothing stays on its Search
 * screen there (`zeroSearchResults`) with no way to leave it but a new
 * search or Back.
 */
export function previewSearchClearOffered(args: {
	readonly platformClears: boolean;
	/** The pane's list holds a search the worker submitted. */
	readonly searched: boolean;
	/** The worker has typed into a field. */
	readonly typed: boolean;
}): boolean {
	return args.platformClears && (args.searched || args.typed);
}

/** Whether Clear also runs the search: the menu asks for it and the
 *  platform searches after Clear at the window's width
 *  (`PreviewPlatformRules.searchOnClearMinWidth`). */
export function searchAfterClear(
	enabled: boolean,
	rules: Pick<PreviewPlatformRules, "searchOnClearMinWidth">,
	windowWidth: number | undefined,
): boolean {
	const minimum = rules.searchOnClearMinWidth;
	return enabled && minimum !== undefined && (windowWidth ?? 0) >= minimum;
}
