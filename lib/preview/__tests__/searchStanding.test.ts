/**
 * When a search the worker ran still stands (`searchStanding.ts`), exit by
 * exit, as Web Apps keeps a query on the page's address
 * (`cloudcare/js/formplayer/utils/utils.js::CloudcareUrl`) and Android keeps
 * it as a step of the session frame (`CommCareSession.stepBack`).
 *
 * The app is the standing-search journey's: Patients (its forms read the
 * search, Results first) and All patients under Clinic.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildSearchStandingBlueprint,
	SEARCH_STANDING_SEED,
} from "@/e2e/lib/searchStandingSeed";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { hiddenSearchInputDef, screenChoosesCaseFirst } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { previewMenuSelectionsLetGo } from "@/lib/preview/menuProjection";
import {
	type PreviewSearchReplay,
	previewSearchArrival,
	previewSearchesStandingAt,
	previewSearchReopened,
	previewSearchRunFollows,
	previewSearchScreenOf,
	previewStandingSearch,
} from "@/lib/preview/searchStanding";
import {
	previewSearchHistoryWrite,
	readPreviewSearchContexts,
	readPreviewStandingSearches,
	withPreviewSearchBegun,
	withPreviewSearchesEnded,
	withPreviewStandingSearches,
} from "@/lib/routing/previewSearchHistory";
import type { Location } from "@/lib/routing/types";
import {
	actionSearch,
	manualSearch,
	searchWithLatestInputs,
	submittedSearchKey,
	submittedSearchOf,
} from "@/lib/session/previewSearchState";
import type {
	PreviewMenuCaseSelection,
	PreviewSearchState,
} from "@/lib/session/types";

const doc = buildSearchStandingBlueprint("search-standing-app");
const { clinic, searching, browsing } = SEARCH_STANDING_SEED;

const patientsSearch: PreviewSearchState = {
	kind: "completed",
	attempt: 1,
	submission: "patients-search",
	answers: { patient_name: "Kofi" },
	matchCount: 1,
};
const browseSearch: PreviewSearchState = {
	kind: "completed",
	attempt: 1,
	submission: "browse-search",
	answers: {},
	matchCount: 2,
};
const states = {
	[searching.moduleUuid]: patientsSearch,
	[browsing.moduleUuid]: browseSearch,
};
const both = new Set(["patients-search", "browse-search"]);

const noFacts = {
	menuSelections: {},
	caseTarget: undefined,
	registrationEntry: undefined,
	parentCaseRequest: undefined,
	listShown: undefined,
} as const;

/** The searches still standing once the worker arrives at `loc`. */
function standingOn(
	loc: Location,
	facts: Parameters<typeof previewSearchScreenOf>[2] = noFacts,
): string[] {
	const screen = previewSearchScreenOf(doc, loc, facts);
	if (screen === undefined) throw new Error("No running screen there.");
	return previewSearchesStandingAt(
		doc,
		states,
		both,
		screen,
		facts.menuSelections,
	).sort();
}

describe("a search stands while the worker is on the path past its list", () => {
	it("stands on its list, its case's details and a form opened from it", () => {
		expect(
			standingOn({ kind: "cases", moduleUuid: searching.moduleUuid }),
		).toEqual(["patients-search"]);
		expect(
			standingOn({
				kind: "cases",
				moduleUuid: searching.moduleUuid,
				caseId: "kofi",
			}),
		).toEqual(["patients-search"]);
		const formUuid = doc.formOrder[searching.moduleUuid][0];
		expect(
			standingOn({ kind: "form", moduleUuid: searching.moduleUuid, formUuid }),
		).toEqual(["patients-search"]);
	});

	it("goes on a screen above its list: the clinic's menu, or the first screen", () => {
		expect(
			standingOn({ kind: "module", moduleUuid: clinic.moduleUuid }),
		).toEqual([]);
		expect(standingOn({ kind: "home" })).toEqual([]);
		// Another list under the same menu holds only its own.
		expect(
			standingOn({ kind: "cases", moduleUuid: browsing.moduleUuid }),
		).toEqual(["browse-search"]);
	});

	it("stands on a menu past its list: one holding the list's case, or one whose forms read it", () => {
		// Patients' forms read the search: its menu lists them after the
		// query has run.
		expect(
			standingOn({ kind: "module", moduleUuid: searching.moduleUuid }),
		).toEqual(["patients-search"]);
		// All patients lists its forms before its case is chosen; once it holds
		// the case, its menu is past its list.
		expect(
			standingOn({ kind: "module", moduleUuid: browsing.moduleUuid }),
		).toEqual([]);
		const held: Record<string, PreviewMenuCaseSelection> = {
			[browsing.moduleUuid]: {
				caseType: SEARCH_STANDING_SEED.caseType,
				cases: [{ caseId: "kofi" }],
			},
		};
		expect(
			standingOn(
				{ kind: "module", moduleUuid: browsing.moduleUuid },
				{ ...noFacts, menuSelections: held },
			),
		).toEqual(["browse-search"]);
	});

	it("stands on a registration form its list's Register action opened, and on a form its Results launched", () => {
		const registerForm = testUuid("search-standing-register");
		const registrationEntry = {
			hostModuleUuid: searching.moduleUuid,
			moduleUuid: clinic.moduleUuid,
			formUuid: registerForm,
		};
		expect(
			standingOn(
				{
					kind: "form",
					moduleUuid: clinic.moduleUuid,
					formUuid: registerForm,
				},
				{ ...noFacts, registrationEntry },
			),
		).toEqual(["patients-search"]);
		expect(
			standingOn(
				{
					kind: "form",
					moduleUuid: clinic.moduleUuid,
					formUuid: registerForm,
				},
				{
					...noFacts,
					caseTarget: {
						formUuid: registerForm,
						searchLaunch: { moduleUuid: searching.moduleUuid, attempt: 1 },
					},
				},
			),
		).toEqual(["patients-search"]);
	});
});

describe("a crumb keeps only what was chosen before the screen it names", () => {
	it("lets a list's search go on the crumb of its menu, and keeps it on the crumb of a case it chose", () => {
		const cut = (screen: Parameters<typeof previewSearchesStandingAt>[3]) =>
			previewSearchesStandingAt(doc, states, both, screen, {}).sort();
		// Web Apps' crumb to a menu keeps the queries recorded strictly
		// before it (`spliceSelections`): the menu's own list asks again.
		expect(cut({ moduleUuid: searching.moduleUuid })).toEqual([]);
		expect(cut({ moduleUuid: clinic.moduleUuid })).toEqual([]);
		// The crumb of a case the list chose names the screen after it.
		expect(cut({ moduleUuid: searching.moduleUuid, through: true })).toEqual([
			"patients-search",
		]);
		// A parent case's list off the trail precedes the cut too.
		expect(
			cut({ moduleUuid: clinic.moduleUuid, alsoPast: [browsing.moduleUuid] }),
		).toEqual(["browse-search"]);
	});

	it("keeps every case chosen up to the crumb, a parent case a list off the trail chose included", () => {
		const selections: Record<string, PreviewMenuCaseSelection> = {
			[searching.moduleUuid]: {
				caseType: SEARCH_STANDING_SEED.caseType,
				cases: [{ caseId: "parent" }],
			},
			[browsing.moduleUuid]: {
				caseType: SEARCH_STANDING_SEED.caseType,
				cases: [{ caseId: "child" }],
			},
		};
		expect(
			previewMenuSelectionsLetGo(doc, selections, {
				moduleUuid: browsing.moduleUuid,
			}).sort(),
		).toEqual([searching.moduleUuid, browsing.moduleUuid].sort());
		expect(
			previewMenuSelectionsLetGo(doc, selections, {
				moduleUuid: browsing.moduleUuid,
				keeps: [searching.moduleUuid],
			}),
		).toEqual([browsing.moduleUuid]);
	});
});

/*
 * A forms-first menu's list that chose a submenu's parent case did so after
 * the submenu's command: a device's frame is [Households, Members,
 * household, person], so Web Apps' Members crumb cuts it to [Households,
 * Members] and keeps only the query data recorded strictly before the cut
 * (`utils.js::CloudcareUrl.spliceSelections`), dropping the search that chose
 * the household. Under a case-first Households the household, and its
 * search, precede Members' command and stay.
 */
describe("a search that chose a submenu's parent case stands as that case does", () => {
	const HOUSEHOLDS = testUuid("standing-households");
	const MEMBERS = testUuid("standing-members");
	const caseTypes = [
		{ name: "household", properties: [] },
		{ name: "person", parent_type: "household", properties: [] },
	];
	const followup = (uuid: string) => ({
		uuid: testUuid(uuid),
		name: "Follow-up",
		type: "followup" as const,
		fields: [f({ kind: "text", id: "notes" })],
	});
	const households = (formsFirst: boolean) => {
		const built = buildDoc({
			caseTypes,
			modules: [
				{
					uuid: HOUSEHOLDS,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						followup("standing-households-followup"),
						...(formsFirst
							? [
									{
										uuid: testUuid("standing-households-register"),
										name: "Register",
										type: "registration" as const,
										fields: [
											f({
												kind: "text",
												id: "case_name",
												caseWrite: {
													caseType: "household",
													property: "case_name",
												},
											}),
										],
									},
								]
							: []),
					],
				},
				{
					uuid: MEMBERS,
					name: "Members",
					caseType: "person",
					parentCaseModuleUuid: HOUSEHOLDS,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [followup("standing-members-followup")],
				},
			],
		});
		built.modules[MEMBERS].parentModuleUuid = HOUSEHOLDS;
		return { ...built, caseTypes };
	};
	const householdSearch: PreviewSearchState = {
		kind: "completed",
		attempt: 1,
		submission: "household-search",
		answers: { household_name: "Mensah" },
		matchCount: 1,
	};
	const held = { [HOUSEHOLDS]: householdSearch };
	const recorded = new Set(["household-search"]);
	const chosen: Record<string, PreviewMenuCaseSelection> = {
		[HOUSEHOLDS]: { caseType: "household", cases: [{ caseId: "mensah" }] },
	};

	it("goes on the submenu's own menu where a forms-first menu's list chose it after the submenu's command", () => {
		const forms = households(true);
		expect(
			screenChoosesCaseFirst(forms, { kind: "menu", moduleUuid: HOUSEHOLDS }),
		).toBe(false);
		const at = (screen: Parameters<typeof previewSearchesStandingAt>[3]) =>
			previewSearchesStandingAt(forms, held, recorded, screen, chosen);
		// The Members crumb, and an arrival on Members' menu with the
		// household still held: the search came after Members' command.
		expect(at({ moduleUuid: MEMBERS })).toEqual([]);
		const menuScreen = previewSearchScreenOf(
			forms,
			{ kind: "module", moduleUuid: MEMBERS },
			{ ...noFacts, menuSelections: chosen },
		);
		if (menuScreen === undefined) throw new Error("Members has a menu.");
		expect(at(menuScreen)).toEqual([]);
		// Members' list, its case's details and its form follow the household,
		// so the search stands there.
		const listScreen = previewSearchScreenOf(
			forms,
			{ kind: "cases", moduleUuid: MEMBERS },
			{ ...noFacts, menuSelections: chosen },
		);
		if (listScreen === undefined) throw new Error("Members has a list.");
		expect(at(listScreen)).toEqual(["household-search"]);
		// The crumb of the person keeps everything chosen up to it.
		expect(at({ moduleUuid: MEMBERS, through: true })).toEqual([
			"household-search",
		]);
	});

	it("stays on the submenu's own menu where a case-first menu chose it before the submenu's command", () => {
		const caseFirst = households(false);
		expect(
			screenChoosesCaseFirst(caseFirst, {
				kind: "menu",
				moduleUuid: HOUSEHOLDS,
			}),
		).toBe(true);
		expect(
			previewSearchesStandingAt(
				caseFirst,
				held,
				recorded,
				{ moduleUuid: MEMBERS },
				chosen,
			),
		).toEqual(["household-search"]);
		// Once the household is let go, nothing on the path holds it.
		expect(
			previewSearchesStandingAt(
				caseFirst,
				held,
				recorded,
				{ moduleUuid: MEMBERS },
				{},
			),
		).toEqual([]);
	});
});

describe("Back and Forward return to the searches each entry held", () => {
	it("a search stands on an entry that records it, and on no other", () => {
		const resultsEntry = withPreviewStandingSearches(
			{ __novaPreviousEntry: { path: "/build/app" } },
			["patients-search"],
		);
		// What else the entry carries stays.
		expect(resultsEntry.__novaPreviousEntry).toEqual({ path: "/build/app" });
		expect(
			previewStandingSearch(
				patientsSearch,
				new Set(readPreviewStandingSearches(resultsEntry)),
			),
		).toBe(patientsSearch);
		// The clinic's entry, pushed by its crumb, recorded none.
		const clinicEntry = withPreviewStandingSearches(resultsEntry, []);
		expect(readPreviewStandingSearches(clinicEntry)).toEqual([]);
		expect(
			previewStandingSearch(
				patientsSearch,
				new Set(readPreviewStandingSearches(clinicEntry)),
			),
		).toBeUndefined();
		// A state no page of this builder wrote holds no search.
		expect(readPreviewStandingSearches(null)).toEqual([]);
		expect(readPreviewStandingSearches({ __novaPreviewSearches: "x" })).toEqual(
			[],
		);
	});

	it("a search the session no longer holds stands nowhere, whatever an entry records", () => {
		// Home and the phone's home screen take every search out of the
		// session (`lib/session/__tests__/store.test.ts`), so an entry that
		// still records one holds none. A submission keeps the session's
		// searches and records none on the screen it lands on
		// (`lib/routing/__tests__/previewSearchHistory.test.ts`).
		expect(
			previewStandingSearch(undefined, new Set(["patients-search"])),
		).toBeUndefined();
		expect(
			previewStandingSearch({ kind: "not-searched" }, new Set(["x"])),
		).toBeUndefined();
	});
});

/*
 * Every list's search lets go by the one rule, whether its menu's forms read
 * it or a Search action runs it, and so does a Search screen the worker asked
 * for again: Web Apps keeps each as query data on the page's address
 * (`utils.js::CloudcareUrl.setQueryData`, `force_manual_search` for the
 * Search screen asked for again), drops it by the same crumb cut, submission
 * and Home, and Formplayer runs the menu's default search on a query step
 * with none (`MenuSessionRunnerService.java::handleQueryScreen`).
 */
describe("a Search action's search and a Search screen asked for again stand and let go as every search does", () => {
	const action = actionSearch({ patient_name: "Kofi" }, "patients-action");
	const manual = manualSearch("patients-manual");

	it("stand on their list and go on a screen above it, or on a crumb to its menu", () => {
		for (const [state, submission] of [
			[action, "patients-action"],
			[manual, "patients-manual"],
		] as const) {
			const held = { [searching.moduleUuid]: state };
			const recorded = new Set([submission]);
			const at = (screen: Parameters<typeof previewSearchesStandingAt>[3]) =>
				previewSearchesStandingAt(doc, held, recorded, screen, {});
			expect(previewStandingSearch(state, recorded)).toBe(state);
			expect(at({ moduleUuid: searching.moduleUuid, through: true })).toEqual([
				submission,
			]);
			expect(at({ moduleUuid: searching.moduleUuid })).toEqual([]);
			expect(at({ moduleUuid: clinic.moduleUuid })).toEqual([]);
			expect(at({ moduleUuid: undefined })).toEqual([]);
			// Home, a submission and a new session take it out of the session.
			expect(previewStandingSearch(undefined, recorded)).toBeUndefined();
		}
	});
});

describe("a list's own search run follows its module's search where it stands", () => {
	const action = actionSearch({ patient_name: "Kofi" }, "patients-action");
	const manual = manualSearch("patients-manual");

	it("drops a run the screen still holds once no search stands, a Search action's included", () => {
		// A list Preview only hid (a form returned to it, Home, a crumb above
		// it) still holds the worker's answers; the search let go, so the
		// menu opens on its default search, or its list, again.
		for (const held of ["patients-action", undefined])
			for (const standing of [undefined, manual])
				expect(
					previewSearchRunFollows({ standing, hasSubmitted: true, held }),
				).toBe("clear");
	});

	it("takes back a search that stands and the run does not hold: on a list built afresh, or one history returns to", () => {
		for (const standing of [action, patientsSearch]) {
			// Built afresh, the run holds nothing; hidden, it was cleared when
			// the search let go, and Back returns to an entry where it stands
			// again, where Web Apps restores the address's query.
			expect(
				previewSearchRunFollows({
					standing,
					hasSubmitted: false,
					held: undefined,
				}),
			).toBe("restore");
			// The run holds another search than the one standing.
			expect(
				previewSearchRunFollows({
					standing,
					hasSubmitted: true,
					held: "earlier",
				}),
			).toBe("restore");
		}
	});

	it("lets go of a search the run held and dropped on its own, and keeps one it still holds", () => {
		for (const standing of [action, patientsSearch]) {
			const submitted = submittedSearchOf(standing);
			if (submitted === undefined) throw new Error("A submitted search.");
			const held = submittedSearchKey(submitted);
			expect(
				previewSearchRunFollows({ standing, hasSubmitted: false, held }),
			).toBe("retire");
			expect(
				previewSearchRunFollows({ standing, hasSubmitted: true, held }),
			).toBe("keep");
		}
	});

	it("keeps a Search screen asked for again, which holds no answers to take back", () => {
		for (const held of ["patients-manual", undefined])
			expect(
				previewSearchRunFollows({
					standing: manual,
					hasSubmitted: false,
					held,
				}),
			).toBe("keep");
		expect(
			previewSearchRunFollows({
				standing: undefined,
				hasSubmitted: false,
				held: undefined,
			}),
		).toBe("keep");
	});
});

describe("Search again opens the Search screen only while the request stands", () => {
	it("opens it until the worker searches, and not once the request lets go", () => {
		const manual = manualSearch("patients-manual");
		expect(previewSearchReopened(manual, false)).toBe(true);
		// The worker's next search closes it.
		expect(previewSearchReopened(manual, true)).toBe(false);
		// A crumb above the list, Home, a submission or a new session: the
		// request stands no more, and the menu runs its default search.
		expect(
			previewSearchReopened(
				previewStandingSearch(manual, new Set(["other"])),
				false,
			),
		).toBe(false);
		expect(previewSearchReopened(undefined, false)).toBe(false);
		// A search, of either kind, is no request for the Search screen.
		expect(previewSearchReopened(patientsSearch, false)).toBe(false);
		expect(
			previewSearchReopened(actionSearch({}, "patients-action"), false),
		).toBe(false);
	});
});

/*
 * Web Apps keeps the answers the worker last gave each query in the page
 * (`utils.js::Utils.setCurrentQueryInputs`, by every `setQueryData`: a Search
 * press and a field changed as the client checks it, each with every prompt
 * view's answer, the hidden ones among them, `query.js::getAnswers`, and the
 * Search screen shown, with none) and never clears them on a submission, a
 * crumb or Home. An address records only that its query ran, and Back
 * answers it with those latest answers (`CloudcareUrl.fromJson` over
 * `Utils.getCurrentQueryInputs`), each prompt they leave out unanswered
 * (`QueryScreen.answerPrompts`). Android keeps each search as a step of its
 * session frame, which holds the query it ran (`CommCareSession.setQueryDatum`).
 *
 * Patients here also carries a hidden field, `searched_by`, which Nova emits
 * as a prompt of its own (`<prompt hidden="true">`).
 */
describe("history gives a search back with the answers its platform runs it with", () => {
	const SESSION = "running-session";
	const patientsModule = searching.moduleUuid;
	const hidden = hiddenSearchInputDef(
		testUuid("search-standing-searched-by"),
		"searched_by",
		"Searched by",
		term(literal("worker")),
	);
	const patients = doc.modules[patientsModule];
	const app = {
		...doc,
		modules: {
			...doc.modules,
			[patientsModule]: {
				...patients,
				caseListConfig: {
					...patients.caseListConfig,
					searchInputs: [
						...(patients.caseListConfig?.searchInputs ?? []),
						hidden,
					],
				},
			},
		},
	} as typeof doc;
	const first: PreviewSearchState = {
		kind: "completed",
		attempt: 1,
		submission: "first-search",
		answers: { patient_name: "Kofi", searched_by: "worker" },
		matchCount: 1,
	};
	/* The list's entry, where the first search was begun, and the next
	 * screen's, pushed from it. */
	const listEntry = withPreviewSearchBegun({}, [], {
		moduleUuid: patientsModule,
		session: SESSION,
		state: first as Exclude<PreviewSearchState, { kind: "not-searched" }>,
	});
	/* A push keeps the rest of the entry's state, the contexts among it
	 * (`previewHeldMenu.ts::builderEntryState`). */
	const nextEntry = previewSearchHistoryWrite(
		listEntry,
		{ ...listEntry },
		"push",
	).written;
	const formLoc: Location = {
		kind: "form",
		moduleUuid: patientsModule,
		formUuid: app.formOrder[patientsModule][0],
	};
	const listLoc: Location = { kind: "cases", moduleUuid: patientsModule };
	const menuLoc: Location = { kind: "module", moduleUuid: patientsModule };
	const arrive = (
		at: Location,
		replay: PreviewSearchReplay,
		states: Readonly<Record<string, PreviewSearchState>>,
		latest: Readonly<Record<string, Readonly<Record<string, string>>>>,
		options: { readonly entry?: unknown; readonly moved?: boolean } = {},
	) => {
		const screen = previewSearchScreenOf(app, at, {
			...noFacts,
			// The shell shows Patients' list exactly on its list's location.
			listShown: at.kind === "cases" ? patientsModule : undefined,
		});
		if (screen === undefined) throw new Error("A running screen.");
		const entry = options.entry ?? (at === listLoc ? listEntry : nextEntry);
		return previewSearchArrival({
			source: app,
			screen,
			selections: {},
			states,
			standing: readPreviewStandingSearches(entry),
			contexts: readPreviewSearchContexts(entry),
			session: SESSION,
			replay,
			moved: options.moved ?? true,
			latest,
		});
	};
	const rerun = (answers: Readonly<Record<string, string>>) => ({
		kind: "running",
		attempt: 1,
		submission: "first-search",
		answers,
	});
	// Home, the list again, and a second search: the session holds it, and
	// the query's latest answers are what that Search press gave.
	const second: PreviewSearchState = {
		kind: "completed",
		attempt: 1,
		submission: "second-search",
		answers: { patient_name: "Ama", searched_by: "worker" },
		matchCount: 1,
	};
	const afterSecond = { [patientsModule]: second };
	const secondPressed = {
		[patientsModule]: { patient_name: "Ama", searched_by: "worker" },
	};

	it("runs the earlier search with the second search's answers on Web Apps after a second search, and its own on Android", () => {
		const web = arrive(listLoc, "latest-answers", afterSecond, secondPressed);
		expect(web.standing).toEqual(["first-search"]);
		// The list runs the query again with the latest answers, the hidden
		// value the press gave among them.
		expect(web.searches[patientsModule]).toEqual(
			rerun({ patient_name: "Ama", searched_by: "worker" }),
		);
		const android = arrive(listLoc, "own-answers", afterSecond, secondPressed);
		expect(android.standing).toEqual(["first-search"]);
		expect(android.searches[patientsModule]).toEqual(first);
	});

	it("keeps the entry's own search on a form and a menu past the list, which run no query to finish it", () => {
		// A form that reads the search opens over what that search found, and
		// the menu lists its forms by it; neither shows the list that would
		// settle a search run again, so neither starts one.
		for (const at of [formLoc, menuLoc]) {
			const web = arrive(at, "latest-answers", afterSecond, secondPressed);
			expect(web.standing).toEqual(["first-search"]);
			expect(web.searches[patientsModule]).toEqual(first);
			expect(
				arrive(at, "latest-answers", afterSecond, {
					[patientsModule]: {},
				}).searches[patientsModule],
			).toEqual(first);
		}
		// The list it opens next takes the latest answers there.
		expect(
			arrive(
				listLoc,
				"latest-answers",
				{ [patientsModule]: first },
				secondPressed,
				{
					entry: nextEntry,
				},
			).searches[patientsModule],
		).toEqual(rerun({ patient_name: "Ama", searched_by: "worker" }));
	});

	it("runs nothing when the entry's record is rewritten on the list the worker is on", () => {
		// The list settling its search writes its context on the entry,
		// which is no step: a field changed since without Search pressed
		// runs nothing.
		expect(
			arrive(
				listLoc,
				"latest-answers",
				{ [patientsModule]: first },
				secondPressed,
				{
					moved: false,
				},
			).searches,
		).toEqual({});
	});

	it("runs the search with no answer at all on Web Apps once a submission landed on its Search screen, its hidden value too", () => {
		// The form's submission ends the search on the screen it lands on,
		// and the entry before keeps it.
		const ended = withPreviewSearchesEnded(nextEntry);
		const landing = previewSearchHistoryWrite(ended, { ...ended }, "push");
		expect(readPreviewStandingSearches(landing.written)).toEqual([]);
		// The landing showed the Search screen, which gives the query no
		// answers (`getMenuView`), and Back reaches the list that ran it;
		// Formplayer answers every prompt from none, the hidden one among them.
		const states = { [patientsModule]: first };
		const latest = { [patientsModule]: {} };
		expect(
			arrive(listLoc, "latest-answers", states, latest).searches[
				patientsModule
			],
		).toEqual(rerun({}));
		// Android's frame keeps the query it ran: nothing to change.
		expect(arrive(listLoc, "own-answers", states, latest).searches).toEqual({});
	});

	it("runs the search with answers typed after Home on Web Apps, though none was searched", () => {
		// Home takes every search out of the session and keeps the answers;
		// on the list again the worker typed a name without searching, which
		// gave the hidden value with it.
		const latest = {
			[patientsModule]: { patient_name: "Esi", searched_by: "worker" },
		};
		expect(
			arrive(listLoc, "latest-answers", {}, latest).searches[patientsModule],
		).toEqual(rerun({ patient_name: "Esi", searched_by: "worker" }));
		expect(
			arrive(listLoc, "own-answers", {}, latest).searches[patientsModule],
		).toEqual(first);
	});

	it("keeps a search whose answers are the latest, and one no answer was given for", () => {
		const states = { [patientsModule]: first };
		expect(
			arrive(listLoc, "latest-answers", states, {
				[patientsModule]: { patient_name: "Kofi", searched_by: "worker" },
			}).searches,
		).toEqual({});
		expect(arrive(listLoc, "latest-answers", states, {}).searches).toEqual({});
	});
});

describe("the answers a search history gives back runs with", () => {
	// A visible field, a date range's two ends and a hidden field.
	const prompts = new Set(["patient_name", "visit:from", "visit:to", "region"]);
	const search: Exclude<PreviewSearchState, { kind: "not-searched" }> = {
		kind: "completed",
		attempt: 2,
		submission: "s",
		answers: { patient_name: "Kofi", "visit:from": "2026-01-01", region: "n" },
		matchCount: 3,
		// The values the device worked out for those answers go with them.
		deviceValues: { value: undefined },
	};

	it("answers every prompt from the latest answers, hidden values included, and runs again", () => {
		// A field change gives every prompt view's answer, the hidden one too.
		expect(
			searchWithLatestInputs(
				search,
				{ patient_name: "Ama", region: "n", stale: "x" },
				prompts,
			),
		).toEqual({
			kind: "running",
			attempt: 2,
			submission: "s",
			answers: { patient_name: "Ama", region: "n" },
		});
		// A Search action's search keeps its kind.
		const action = actionSearch({ patient_name: "Kofi", region: "n" }, "a");
		expect(
			searchWithLatestInputs(
				action as Exclude<PreviewSearchState, { kind: "not-searched" }>,
				{ patient_name: "Ama", region: "n" },
				prompts,
			),
		).toEqual({
			kind: "action",
			submission: "a",
			answers: { patient_name: "Ama", region: "n" },
		});
	});

	it("drops the hidden values with every answer where the Search screen was drawn last", () => {
		// The screen drawn writes `{}`, and Formplayer answers each prompt it
		// leaves out with nothing (`answerUserPrompt(key, null)` removes it).
		expect(searchWithLatestInputs(search, {}, prompts)).toEqual({
			kind: "running",
			attempt: 2,
			submission: "s",
			answers: {},
		});
	});

	it("is the same search where nothing differs, and where Web Apps would not answer it", () => {
		expect(
			searchWithLatestInputs(
				search,
				{ patient_name: "Kofi", "visit:from": "2026-01-01", region: "n" },
				prompts,
			),
		).toBe(search);
		expect(searchWithLatestInputs(search, undefined, prompts)).toBe(search);
		// The menu's default search writes no query data, so it runs as the
		// default search again.
		const automatic = { ...search, automatic: true as const };
		expect(searchWithLatestInputs(automatic, {}, prompts)).toBe(automatic);
		// A Search screen asked for again holds no answers.
		const manual = manualSearch("m") as Exclude<
			PreviewSearchState,
			{ kind: "not-searched" }
		>;
		expect(searchWithLatestInputs(manual, {}, prompts)).toBe(manual);
		// A search a registration keyed to its case is read by that case.
		const registered = { ...search, registeredCaseId: "case-1" };
		expect(searchWithLatestInputs(registered, {}, prompts)).toBe(registered);
	});

	it("is taken again by the list's run when it comes back with other answers", () => {
		const ran = submittedSearchOf(search);
		if (ran === undefined) throw new Error("A submitted search.");
		const again = searchWithLatestInputs(search, {}, prompts);
		expect(
			previewSearchRunFollows({
				standing: again,
				hasSubmitted: true,
				held: submittedSearchKey(ran),
			}),
		).toBe("restore");
	});
});
