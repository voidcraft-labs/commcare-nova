import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { PreviewSearchState } from "@/lib/session/types";
import { noMatchesFormAdmission, noMatchesRefusalCopy } from "../noMatchesForm";

const MODULE = testUuid("mod-patients");
const OTHER = testUuid("mod-other");
const answers = { patient_name: "Zzz" };
const entry = { entry: { kind: "search-no-matches" as const } };

function completed(
	matchCount: number,
	attempt = 1,
): Extract<PreviewSearchState, { kind: "completed" }> {
	return { kind: "completed", attempt, answers, matchCount };
}

describe("noMatchesFormAdmission", () => {
	it("does not apply to a form without the entry", () => {
		expect(
			noMatchesFormAdmission({
				form: {},
				moduleUuid: MODULE,
				launch: undefined,
				searchState: undefined,
			}),
		).toEqual({ kind: "not-applicable" });
		expect(
			noMatchesFormAdmission({
				form: undefined,
				moduleUuid: MODULE,
				launch: undefined,
				searchState: completed(0),
			}),
		).toEqual({ kind: "not-applicable" });
	});

	it("admits the form the Register action launched on an empty completed search", () => {
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch: { moduleUuid: MODULE, attempt: 1 },
				searchState: completed(0),
			}),
		).toEqual({ kind: "admitted", answers });
	});

	it("refuses a direct visit with no launch", () => {
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch: undefined,
				searchState: completed(0),
			}),
		).toEqual({ kind: "refused", reason: "no-launch" });
	});

	it("refuses a launch from another module's search", () => {
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch: { moduleUuid: OTHER, attempt: 1 },
				searchState: completed(0),
			}),
		).toEqual({ kind: "refused", reason: "foreign-module" });
	});

	it("refuses before a search, while one runs, and after one fails", () => {
		const launch = { moduleUuid: MODULE, attempt: 1 };
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch,
				searchState: undefined,
			}),
		).toEqual({ kind: "refused", reason: "not-searched" });
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch,
				searchState: { kind: "not-searched" },
			}),
		).toEqual({ kind: "refused", reason: "not-searched" });
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch,
				searchState: { kind: "running", attempt: 1, answers },
			}),
		).toEqual({ kind: "refused", reason: "search-running" });
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch,
				searchState: { kind: "failed", attempt: 1, answers, reason: "error" },
			}),
		).toEqual({ kind: "refused", reason: "search-failed" });
	});

	it("refuses when the search found cases, including the case it registered", () => {
		const launch = { moduleUuid: MODULE, attempt: 1 };
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch,
				searchState: completed(3),
			}),
		).toEqual({ kind: "refused", reason: "has-matches" });
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch,
				searchState: { ...completed(1), registeredCaseId: "case-new" },
			}),
		).toEqual({ kind: "refused", reason: "has-matches" });
	});

	it("refuses a launch a later search superseded", () => {
		expect(
			noMatchesFormAdmission({
				form: entry,
				moduleUuid: MODULE,
				launch: { moduleUuid: MODULE, attempt: 1 },
				searchState: completed(0, 2),
			}),
		).toEqual({ kind: "refused", reason: "stale-launch" });
	});

	it("names the next step in every refusal", () => {
		for (const reason of [
			"no-launch",
			"foreign-module",
			"not-searched",
			"search-running",
			"search-failed",
			"has-matches",
			"stale-launch",
		] as const) {
			const copy = noMatchesRefusalCopy(reason);
			expect(copy.title).toBe(
				"This form opens after a search finds no matches",
			);
			expect(copy.description.length).toBeGreaterThan(0);
			expect(copy.description).not.toMatch(/—|\.\.\./);
		}
	});
});
