/**
 * Whether the running app opens a module's case list registration form,
 * read from the module's slot (`Module.caseListRegistrationForm`), where it
 * returns after submit, and what a form's `#search/` reads. Pure: both
 * screens and App Tests ask these, so a form admitted another way than the
 * Register action on its module's empty search fails here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { simpleSearchInputDef } from "@/lib/domain";
import type { PreviewSearchState } from "@/lib/session/types";
import {
	caseListRegistrationAdmission,
	caseListRegistrationPostSubmit,
	caseListRegistrationRefusalCopy,
	formSearchAnswers,
	isCaseListRegistrationForm,
} from "../caseListRegistration";

const MODULE = testUuid("mod-patients");
const OTHER = testUuid("mod-other");
const REGISTER = testUuid("form-register");
const VISIT = testUuid("form-visit");
const answers = { patient_name: "Zzz" };

function docWith(postSubmit?: "firstMenu") {
	return buildDoc({
		modules: [
			{
				uuid: "mod-patients",
				name: "Patients",
				caseType: "patient",
				caseListRegistrationForm: { formUuid: "form-register" },
				forms: [
					{ uuid: "form-visit", name: "Visit", type: "followup" },
					{
						uuid: "form-register",
						name: "Register",
						type: "registration",
						...(postSubmit === undefined ? {} : { postSubmit }),
					},
				],
			},
			{ uuid: "mod-other", name: "Other", forms: [] },
		],
	});
}
const doc = docWith();
const entry = { doc, formUuid: REGISTER };

function completed(
	matchCount: number,
	attempt = 1,
): Extract<PreviewSearchState, { kind: "completed" }> {
	return {
		kind: "completed",
		attempt,
		submission: `search-${attempt}`,
		answers,
		matchCount,
	};
}

describe("caseListRegistrationAdmission", () => {
	it("does not apply to a form its module's slot does not name", () => {
		expect(
			caseListRegistrationAdmission({
				doc,
				formUuid: VISIT,
				moduleUuid: MODULE,
				launch: undefined,
				searchState: undefined,
			}),
		).toEqual({ kind: "not-applicable" });
		expect(
			caseListRegistrationAdmission({
				doc,
				formUuid: undefined,
				moduleUuid: MODULE,
				launch: undefined,
				searchState: completed(0),
			}),
		).toEqual({ kind: "not-applicable" });
	});

	it("admits the form the Register action launched on an empty completed search", () => {
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch: { moduleUuid: MODULE, attempt: 1 },
				searchState: completed(0),
			}),
		).toEqual({ kind: "admitted", answers });
	});

	it("refuses a direct visit with no launch", () => {
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch: undefined,
				searchState: completed(0),
			}),
		).toEqual({ kind: "refused", reason: "no-launch" });
	});

	it("refuses a launch from another module's search", () => {
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch: { moduleUuid: OTHER, attempt: 1 },
				searchState: completed(0),
			}),
		).toEqual({ kind: "refused", reason: "foreign-module" });
	});

	it("refuses before a search, while one runs, and after one fails", () => {
		const launch = { moduleUuid: MODULE, attempt: 1 };
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch,
				searchState: undefined,
			}),
		).toEqual({ kind: "refused", reason: "not-searched" });
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch,
				searchState: { kind: "not-searched" },
			}),
		).toEqual({ kind: "refused", reason: "not-searched" });
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch,
				searchState: {
					kind: "running",
					attempt: 1,
					submission: "search-1",
					answers,
				},
			}),
		).toEqual({ kind: "refused", reason: "search-running" });
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch,
				searchState: {
					kind: "failed",
					attempt: 1,
					submission: "search-1",
					answers,
					reason: "error",
				},
			}),
		).toEqual({ kind: "refused", reason: "search-failed" });
	});

	it("refuses when the search found cases, including the case it registered", () => {
		const launch = { moduleUuid: MODULE, attempt: 1 };
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch,
				searchState: completed(3),
			}),
		).toEqual({ kind: "refused", reason: "has-matches" });
		expect(
			caseListRegistrationAdmission({
				...entry,
				moduleUuid: MODULE,
				launch,
				searchState: { ...completed(1), registeredCaseId: "case-new" },
			}),
		).toEqual({ kind: "refused", reason: "has-matches" });
	});

	it("refuses a launch a later search superseded", () => {
		expect(
			caseListRegistrationAdmission({
				...entry,
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
			const copy = caseListRegistrationRefusalCopy(reason);
			expect(copy.title).toBe(
				"This form opens after a search finds no matches",
			);
			expect(copy.description.length).toBeGreaterThan(0);
			expect(copy.description).not.toMatch(/—|\.\.\./);
		}
	});
});

describe("isCaseListRegistrationForm", () => {
	it("is the form the module's slot names, and no other", () => {
		expect(isCaseListRegistrationForm(doc, REGISTER)).toBe(true);
		expect(isCaseListRegistrationForm(doc, VISIT)).toBe(false);
		expect(isCaseListRegistrationForm(doc, undefined)).toBe(false);
	});
});

describe("caseListRegistrationPostSubmit", () => {
	it("returns to Results unless the form holds firstMenu", () => {
		expect(caseListRegistrationPostSubmit(doc, REGISTER)).toBe("results");
		expect(caseListRegistrationPostSubmit(docWith("firstMenu"), REGISTER)).toBe(
			"firstMenu",
		);
		expect(caseListRegistrationPostSubmit(doc, VISIT)).toBeUndefined();
	});
});

describe("formSearchAnswers", () => {
	const searchInputs = [
		simpleSearchInputDef(
			testUuid("input-patient-name"),
			"patient_name",
			"Patient name",
			"text",
			"case_name",
		),
	];
	const defaults = new Map([["patient_name", "Ama"]]);
	const answersOf = (args: {
		readonly admission: Parameters<typeof formSearchAnswers>[0]["admission"];
		readonly formsReadSearch: boolean;
		readonly searchState: PreviewSearchState | undefined;
		readonly openedByLink?: boolean;
	}) => {
		const found = formSearchAnswers({
			searchInputs,
			defaults,
			openedByLink: false,
			...args,
		});
		return found === undefined ? undefined : Object.fromEntries(found);
	};

	it("gives a form of a menu whose forms read the search its completed search's answers", () => {
		expect(
			answersOf({
				admission: { kind: "not-applicable" },
				formsReadSearch: true,
				searchState: completed(3),
			}),
		).toEqual({ patient_name: "Zzz" });
	});

	it("gives it the Search fields' starting values when a link or an entry point opened it", () => {
		for (const searchState of [undefined, { kind: "not-searched" } as const])
			expect(
				answersOf({
					admission: { kind: "not-applicable" },
					formsReadSearch: true,
					searchState,
				}),
			).toEqual({ patient_name: "Ama" });
	});

	it("gives a form a link opened the starting values, even after a search in its module", () => {
		expect(
			answersOf({
				admission: { kind: "not-applicable" },
				formsReadSearch: true,
				searchState: completed(3),
				openedByLink: true,
			}),
		).toEqual({ patient_name: "Ama" });
	});

	it("gives a case list registration form its admitted launch's answers", () => {
		expect(
			answersOf({
				admission: { kind: "admitted", answers: { patient_name: "Kofi" } },
				formsReadSearch: true,
				searchState: completed(0),
			}),
		).toEqual({ patient_name: "Kofi" });
	});

	it("gives a form of any other module none", () => {
		expect(
			answersOf({
				admission: { kind: "not-applicable" },
				formsReadSearch: false,
				searchState: completed(3),
			}),
		).toBeUndefined();
	});
});
