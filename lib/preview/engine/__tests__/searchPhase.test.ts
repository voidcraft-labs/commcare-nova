import { describe, expect, it } from "vitest";
import type { CaseRowWithCalculated } from "../caseDataBindingTypes";
import { searchOutcomeFromLoad } from "../searchPhase";

const row = {
	case_id: "c1",
	calculated: {},
} as unknown as CaseRowWithCalculated;

describe("searchOutcomeFromLoad", () => {
	it("completes with the full population count when the server reports it", () => {
		expect(
			searchOutcomeFromLoad({
				kind: "rows",
				rows: [row],
				totalCount: 57,
				constraintSource: "worker-search",
			}),
		).toEqual({ kind: "completed", matchCount: 57 });
	});

	it("falls back to the page's rows for an unpaged read", () => {
		expect(
			searchOutcomeFromLoad({
				kind: "rows",
				rows: [row, row],
				constraintSource: "worker-search",
			}),
		).toEqual({ kind: "completed", matchCount: 2 });
	});

	it("completes an empty answer with zero matches", () => {
		expect(
			searchOutcomeFromLoad({
				kind: "empty",
				constraintSource: "worker-search",
			}),
		).toEqual({ kind: "completed", matchCount: 0 });
	});

	it("fails on every rejection, naming its kind", () => {
		expect(
			searchOutcomeFromLoad({
				kind: "invalid-search",
				message: "m",
				repair: "inputs",
			}),
		).toEqual({ kind: "failed", reason: "invalid-search" });
		expect(searchOutcomeFromLoad({ kind: "error", message: "m" })).toEqual({
			kind: "failed",
			reason: "error",
		});
		expect(searchOutcomeFromLoad({ kind: "unauthenticated" })).toEqual({
			kind: "failed",
			reason: "unauthenticated",
		});
		expect(
			searchOutcomeFromLoad({ kind: "persona-unavailable", message: "m" }),
		).toEqual({ kind: "failed", reason: "persona-unavailable" });
	});

	it("settles nothing while the load is idle or in flight", () => {
		expect(searchOutcomeFromLoad({ kind: "idle" })).toBeUndefined();
		expect(searchOutcomeFromLoad({ kind: "loading" })).toBeUndefined();
	});
});
