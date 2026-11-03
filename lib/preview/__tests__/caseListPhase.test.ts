/**
 * Which screen a module's case list opens on, for each search workflow,
 * whether the menu's forms read the search, the Search button's condition
 * and each platform. Pure: `caseListStep` is the one decision the running
 * case list and App Tests read, so a Preview that opens a list Web Apps
 * never shows (or a Search screen Android never shows) fails here.
 */

import { describe, expect, it } from "vitest";
import type { SearchWorkflow } from "@/lib/domain";
import { caseListStep, resultsConstraintContext } from "../caseListPhase";
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
