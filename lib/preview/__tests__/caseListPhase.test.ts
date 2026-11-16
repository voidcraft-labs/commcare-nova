/**
 * Which screen a module's case list opens on, for each search workflow,
 * whether the menu's forms read the search, the Search button's condition
 * and each platform. Pure: `caseListStep` is the one decision the running
 * case list and App Tests read, so a Preview that opens a list Web Apps
 * never shows (or a Search screen Android never shows) fails here.
 */

import { describe, expect, it } from "vitest";
import type { SearchWorkflow } from "@/lib/domain";
import {
	caseListDefaultSearchLaunch,
	caseListDefaultSearchOpening,
	caseListLaunchesDefaultSearch,
	caseListReadsResults,
	caseListScreenStep,
	caseListStep,
	resultsConstraintContext,
} from "../caseListPhase";
import {
	ANDROID_RULES,
	WEB_APPS_RULES,
} from "../engine/__tests__/fixtures/previewDevices";

type StepArgs = Parameters<typeof caseListStep>[0];

function step(
	overrides: Partial<StepArgs> & Pick<StepArgs, "workflow" | "rules">,
): ReturnType<typeof caseListStep> {
	return caseListStep({
		formsReadSearch: false,
		searchRelevant: true,
		hasSubmitted: false,
		...overrides,
	});
}

const WORKFLOWS: readonly (SearchWorkflow | undefined)[] = [
	undefined,
	"listFirst",
	"searchFirst",
	"skipToResults",
];

describe("caseListStep", () => {
	it("browses a module with no effective search on both platforms", () => {
		for (const rules of [WEB_APPS_RULES, ANDROID_RULES])
			for (const hasSubmitted of [false, true])
				expect(step({ workflow: undefined, rules, hasSubmitted })).toBe(
					"browse",
				);
	});

	it("opens each workflow in Web Apps where the Search button shows", () => {
		const opened = (workflow: SearchWorkflow, hasSubmitted: boolean) =>
			step({ workflow, rules: WEB_APPS_RULES, hasSubmitted });
		expect(opened("listFirst", false)).toBe("browse");
		expect(opened("listFirst", true)).toBe("browse");
		expect(opened("searchFirst", false)).toBe("search");
		expect(opened("searchFirst", true)).toBe("results");
		expect(opened("skipToResults", false)).toBe("results");
		expect(opened("skipToResults", true)).toBe("results");
	});

	it("shows skip to results' Search screen after Search again, until the worker searches", () => {
		expect(
			step({
				workflow: "skipToResults",
				rules: WEB_APPS_RULES,
				searchReopened: true,
			}),
		).toBe("search");
		expect(
			step({
				workflow: "skipToResults",
				rules: WEB_APPS_RULES,
				searchReopened: true,
				hasSubmitted: true,
			}),
		).toBe("results");
	});

	it("browses every workflow on Android, which never launches the Search action", () => {
		for (const workflow of WORKFLOWS)
			for (const hasSubmitted of [false, true])
				expect(
					step({
						workflow,
						rules: ANDROID_RULES,
						hasSubmitted,
						submittedFoundNothing: false,
					}),
				).toBe("browse");
	});

	it("browses in Web Apps where the Search button's condition is false", () => {
		for (const workflow of WORKFLOWS)
			expect(
				step({ workflow, rules: WEB_APPS_RULES, searchRelevant: false }),
			).toBe("browse");
	});

	it("keeps forms that read the search off the list until a search runs, whatever the condition", () => {
		for (const searchRelevant of [true, false]) {
			expect(
				step({
					workflow: "searchFirst",
					formsReadSearch: true,
					searchRelevant,
					rules: WEB_APPS_RULES,
				}),
			).toBe("search");
			expect(
				step({
					workflow: "searchFirst",
					formsReadSearch: true,
					searchRelevant,
					rules: WEB_APPS_RULES,
					hasSubmitted: true,
				}),
			).toBe("results");
			expect(
				step({
					workflow: "skipToResults",
					formsReadSearch: true,
					searchRelevant,
					rules: WEB_APPS_RULES,
				}),
			).toBe("results");
		}
	});

	it("keeps the Android Search screen after a search that found nothing", () => {
		for (const workflow of WORKFLOWS)
			expect(
				step({
					workflow,
					rules: ANDROID_RULES,
					hasSubmitted: true,
					submittedFoundNothing: true,
				}),
			).toBe("search");
		expect(
			step({
				workflow: "listFirst",
				rules: WEB_APPS_RULES,
				hasSubmitted: true,
				submittedFoundNothing: true,
			}),
		).toBe("browse");
		expect(
			step({
				workflow: "searchFirst",
				rules: WEB_APPS_RULES,
				hasSubmitted: true,
				submittedFoundNothing: true,
			}),
		).toBe("results");
	});
});

describe("caseListScreenStep", () => {
	const screen = (
		overrides: Partial<Parameters<typeof caseListScreenStep>[0]> &
			Pick<StepArgs, "workflow" | "rules">,
	) =>
		caseListScreenStep({
			formsReadSearch: false,
			searchRelevant: "undecided",
			hasSubmitted: false,
			...overrides,
		});

	it("waits in Web Apps where an undecided Search button condition decides between the list and the search", () => {
		expect(screen({ workflow: "skipToResults", rules: WEB_APPS_RULES })).toBe(
			"waiting",
		);
		expect(screen({ workflow: "searchFirst", rules: WEB_APPS_RULES })).toBe(
			"waiting",
		);
		expect(
			screen({
				workflow: "searchFirst",
				rules: WEB_APPS_RULES,
				hasSubmitted: true,
			}),
		).toBe("waiting");
	});

	it("shows the one step an undecided condition cannot change", () => {
		for (const workflow of WORKFLOWS)
			expect(screen({ workflow, rules: ANDROID_RULES })).toBe("browse");
		expect(screen({ workflow: "listFirst", rules: WEB_APPS_RULES })).toBe(
			"browse",
		);
		expect(
			screen({
				workflow: "skipToResults",
				formsReadSearch: true,
				rules: WEB_APPS_RULES,
			}),
		).toBe("results");
		expect(
			screen({
				workflow: "searchFirst",
				formsReadSearch: true,
				rules: WEB_APPS_RULES,
			}),
		).toBe("search");
	});

	it("is the decided step once the condition is decided", () => {
		for (const workflow of WORKFLOWS)
			for (const rules of [WEB_APPS_RULES, ANDROID_RULES])
				for (const searchRelevant of [true, false])
					expect(screen({ workflow, rules, searchRelevant })).toBe(
						step({ workflow, rules, searchRelevant }),
					);
	});
});

describe("caseListReadsResults", () => {
	const run = (hasSubmitted: boolean, readsRegisteredCase = false) => ({
		hasSubmitted,
		readsRegisteredCase,
	});

	it("reads the worker's list whatever has been searched", () => {
		expect(caseListReadsResults("browse", run(false))).toBe(true);
		expect(caseListReadsResults("browse", run(true))).toBe(true);
	});

	it("reads no Results before the menu's default search has run", () => {
		expect(caseListReadsResults("results", run(false))).toBe(false);
		expect(caseListReadsResults("results", run(true))).toBe(true);
		expect(caseListReadsResults("results", run(false, true))).toBe(true);
	});

	it("reads nothing on the Search screen or while the step waits", () => {
		for (const submitted of [false, true]) {
			expect(caseListReadsResults("search", run(submitted))).toBe(false);
			expect(caseListReadsResults("waiting", run(submitted, true))).toBe(false);
		}
	});
});

describe("caseListLaunchesDefaultSearch", () => {
	const launch = (
		overrides: Partial<Parameters<typeof caseListLaunchesDefaultSearch>[0]>,
	) =>
		caseListLaunchesDefaultSearch({
			step: "results",
			hasSubmitted: false,
			pending: false,
			refused: false,
			readsRegisteredCase: false,
			standingSearch: false,
			...overrides,
		});

	it("runs the default search as a skip to results menu opens", () => {
		expect(launch({})).toBe(true);
	});

	it("keeps a standing search the worker ran when the list shows again", () => {
		// A menu whose forms read the search, shown again after one of its
		// forms (a fresh screen, nothing submitted on it yet): the step is
		// Results, and the session's search is what Formplayer runs again with
		// its own answers, so no default search replaces it, before or after
		// the screen takes the search back.
		const shownAgain = step({
			workflow: "skipToResults",
			formsReadSearch: true,
			rules: WEB_APPS_RULES,
		});
		expect(shownAgain).toBe("results");
		expect(launch({ step: shownAgain, standingSearch: true })).toBe(false);
		expect(
			launch({ step: shownAgain, standingSearch: true, hasSubmitted: true }),
		).toBe(false);
	});

	it("runs nothing while the worker is pending, a search stands submitted, or a registered case is read", () => {
		expect(launch({ pending: true })).toBe(false);
		expect(launch({ hasSubmitted: true })).toBe(false);
		expect(launch({ readsRegisteredCase: true })).toBe(false);
	});

	it("runs nothing off Results", () => {
		for (const other of ["browse", "search", "waiting"] as const)
			expect(launch({ step: other })).toBe(false);
	});

	it("runs nothing on a Search screen refused as it opened", () => {
		// Core's query manager fails as Formplayer builds the query screen,
		// before `handleQueryScreen` runs the default search.
		expect(launch({ refused: true })).toBe(false);
	});
});

describe("the default search's launch", () => {
	const settings = { moduleUuid: "patients", workflow: "skipToResults" };
	/** The screen's passes, as its effect runs them: each opening (or none)
	 *  in turn, and whether that pass launched the default search. */
	function passes(
		openings: readonly (
			| { readonly session: string; readonly launches: boolean }
			| undefined
		)[],
	): boolean[] {
		let launched: string | undefined;
		return openings.map((opening) => {
			const pass = caseListDefaultSearchLaunch(
				launched,
				opening === undefined
					? undefined
					: caseListDefaultSearchOpening({ ...opening, settings }),
			);
			launched = pass.launched;
			return pass.launch;
		});
	}

	it("runs once as the menu opens, and not again for the same opening", () => {
		const opened = { session: "a", launches: true };
		expect(passes([opened, opened])).toEqual([true, false]);
	});

	it("runs again for a new Preview session on the same menu with the same settings", () => {
		// Leaving Preview and entering it again, or another worker: the hidden
		// list keeps its last opening, and the screen's run lost its search.
		expect(
			passes([
				{ session: "a", launches: true },
				{ session: "b", launches: true },
			]),
		).toEqual([true, true]);
	});

	it("runs again once a search the list held is let go, or a refusal is lifted", () => {
		const opened = { session: "a", launches: true };
		const holding = { session: "a", launches: false };
		expect(passes([opened, holding, opened])).toEqual([true, false, true]);
		// A worker assigned nowhere: refused, so nothing runs; the worker
		// placed, the menu opens on its default search.
		expect(passes([holding, opened])).toEqual([false, true]);
	});

	it("names nothing where the default search does not run", () => {
		expect(
			caseListDefaultSearchOpening({ launches: false, session: "a", settings }),
		).toBe(undefined);
		expect(caseListDefaultSearchLaunch("x", undefined)).toEqual({
			launched: undefined,
			launch: false,
		});
	});
});

describe("resultsConstraintContext", () => {
	it("reads an unconstrained empty search on Results as the worker's search", () => {
		expect(resultsConstraintContext("results", "unconstrained")).toBe(
			"worker-search",
		);
	});

	it("keeps authored rules and worker searches as they are", () => {
		expect(resultsConstraintContext("results", "authored-rules")).toBe(
			"authored-rules",
		);
		expect(resultsConstraintContext("results", "worker-search")).toBe(
			"worker-search",
		);
	});

	it("leaves the browse composition alone", () => {
		expect(resultsConstraintContext("browse", "unconstrained")).toBe(
			"unconstrained",
		);
		expect(resultsConstraintContext("search", "unconstrained")).toBe(
			"unconstrained",
		);
	});
});
