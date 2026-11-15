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
import { previewMenuSelectionsLetGo } from "@/lib/preview/menuProjection";
import {
	previewSearchesStandingAt,
	previewSearchReopened,
	previewSearchRunFollows,
	previewSearchScreenOf,
	previewStandingSearch,
} from "@/lib/preview/searchStanding";
import {
	readPreviewStandingSearches,
	withPreviewStandingSearches,
} from "@/lib/routing/previewSearchHistory";
import type { Location } from "@/lib/routing/types";
import { actionSearch, manualSearch } from "@/lib/session/previewSearchState";
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
} as const;

/** The searches still standing once the worker arrives at `loc`. */
function standingOn(
	loc: Location,
	facts: Parameters<typeof previewSearchScreenOf>[2] = noFacts,
): string[] {
	const screen = previewSearchScreenOf(doc, loc, facts);
	if (screen === undefined) throw new Error("No running screen there.");
	return previewSearchesStandingAt(doc, states, both, screen).sort();
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
			previewSearchesStandingAt(doc, states, both, screen).sort();
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
				previewSearchesStandingAt(doc, held, recorded, screen);
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
			const held =
				standing.kind === "action" ? "patients-action" : "patients-search";
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
