import { describe, expect, it } from "vitest";
import { caseListStep, resultsConstraintContext } from "../caseListPhase";

describe("caseListStep", () => {
	it("keeps a browse-then-search module on the ordinary composition", () => {
		for (const hasVisibleInputs of [true, false]) {
			for (const hasSubmitted of [true, false]) {
				expect(
					caseListStep({ searchFirst: false, hasVisibleInputs, hasSubmitted }),
				).toBe("browse");
			}
		}
	});

	it("opens a search-first module on Search until a search completes", () => {
		expect(
			caseListStep({
				searchFirst: true,
				hasVisibleInputs: true,
				hasSubmitted: false,
			}),
		).toBe("search");
		expect(
			caseListStep({
				searchFirst: true,
				hasVisibleInputs: true,
				hasSubmitted: true,
			}),
		).toBe("results");
	});

	it("puts a search-first module with nothing to answer on Results at once", () => {
		expect(
			caseListStep({
				searchFirst: true,
				hasVisibleInputs: false,
				hasSubmitted: false,
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
