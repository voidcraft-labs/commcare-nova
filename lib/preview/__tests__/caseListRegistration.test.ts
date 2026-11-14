/**
 * Whether the running app opens a module's case list registration form,
 * read from the module's slot (`Module.caseListRegistrationForm`), where it
 * returns after submit, and what a form's `#search/` reads. Pure: both
 * screens and App Tests ask these, so a form admitted another way than the
 * Register action on its module's empty search fails here.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseListRegistrationReturn,
	type PostSubmitDestination,
	simpleSearchInputDef,
} from "@/lib/domain";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { proseText } from "@/lib/domain/prose";
import type { PreviewSearchState } from "@/lib/session/types";
import {
	alwaysOfferedRegistrationReturn,
	caseListRegistrationAdmission,
	caseListRegistrationPostSubmit,
	caseListRegistrationRefusalCopy,
	formSearchAnswers,
	isCaseListRegistrationForm,
	previewRegisterAction,
	selectionsAfterRegistrationReturn,
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

// ── A case list that always offers another menu's registration form ──────

const HOST = testUuid("host");
const OFFERED = testUuid("offered");
const OFFERED_MENU = testUuid("offered-menu");
const ICON = asMediaAssetId(testUuid("register-icon"));

/** `Patients` lists patients for a follow-up (or, with `bare`, is its case
 *  list alone) and always offers `Registration`'s form. */
function offeringDoc(
	afterSubmit: CaseListRegistrationReturn,
	options: {
		readonly bare?: boolean;
		readonly formPostSubmit?: PostSubmitDestination;
	} = {},
): BlueprintDoc {
	const list = caseListConfig([{ field: "case_name", header: "Name" }]);
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "host",
				name: "Patients",
				caseType: "patient",
				caseListConfig: list,
				...(options.bare === true
					? { caseListMenuItem: {} }
					: {
							forms: [
								{
									uuid: "host-visit",
									name: "Visit",
									type: "followup" as const,
									fields: [
										f({ kind: "text", id: "note", label: proseText("Note") }),
									],
								},
							],
						}),
			},
			{
				uuid: "offered-menu",
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "offered",
						name: "Register patient",
						type: "registration" as const,
						...(options.formPostSubmit !== undefined && {
							postSubmit: options.formPostSubmit,
						}),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[HOST].caseListRegistrationForm = {
		kind: "always",
		formUuid: OFFERED,
		label: "New patient",
		icon: ICON,
		afterSubmit,
	};
	return doc;
}

const launch = { hostModuleUuid: HOST };

describe("previewRegisterAction", () => {
	it("offers the form where it stands, under the slot's label, its icon on Android alone", () => {
		const doc = offeringDoc("case-list");
		expect(previewRegisterAction(doc, HOST, "android")).toMatchObject({
			arm: "always",
			formUuid: OFFERED,
			formModuleUuid: OFFERED_MENU,
			label: "New patient",
			icon: ICON,
		});
		expect(previewRegisterAction(doc, HOST, "web-apps")).toMatchObject({
			arm: "always",
			label: "New patient",
			icon: undefined,
			audioLabel: undefined,
		});
	});

	it("offers a module's own form after an empty search from the host itself", () => {
		expect(previewRegisterAction(doc, MODULE, "web-apps")).toMatchObject({
			arm: "after-empty-search",
			formUuid: REGISTER,
			formModuleUuid: MODULE,
			label: "Register",
		});
		expect(previewRegisterAction(doc, OTHER, "web-apps")).toBeUndefined();
	});
});

describe("alwaysOfferedRegistrationReturn", () => {
	it("goes on to the host's forms with the new case chosen", () => {
		expect(
			alwaysOfferedRegistrationReturn(
				offeringDoc("new-case"),
				OFFERED,
				launch,
				"new-case-id",
			),
		).toEqual({
			screen: { kind: "menu", moduleUuid: HOST },
			selectingModuleUuids: [HOST],
		});
	});

	it("returns to the host's screen with no case chosen where the form created none", () => {
		expect(
			alwaysOfferedRegistrationReturn(
				offeringDoc("new-case"),
				OFFERED,
				launch,
				undefined,
			),
		).toEqual({
			screen: { kind: "menu", moduleUuid: HOST },
			selectingModuleUuids: [],
		});
	});

	it("returns Back to this list with no case chosen, a created case or not", () => {
		for (const created of ["new-case-id", undefined])
			expect(
				alwaysOfferedRegistrationReturn(
					offeringDoc("case-list"),
					OFFERED,
					launch,
					created,
				),
			).toEqual({
				screen: { kind: "menu", moduleUuid: HOST },
				selectingModuleUuids: [],
			});
	});

	it("carries no selection onto a bare case list, whose frame is its command alone", () => {
		expect(
			alwaysOfferedRegistrationReturn(
				offeringDoc("new-case", { bare: true }),
				OFFERED,
				launch,
				"new-case-id",
			),
		).toEqual({
			screen: { kind: "menu", moduleUuid: HOST },
			selectingModuleUuids: [],
		});
	});

	it("is ordinary routing for a form opened another way, or with its own after-submit", () => {
		const doc = offeringDoc("new-case");
		expect(
			alwaysOfferedRegistrationReturn(doc, OFFERED, undefined, "id"),
		).toBeUndefined();
		expect(
			alwaysOfferedRegistrationReturn(
				doc,
				OFFERED,
				{ hostModuleUuid: OFFERED_MENU },
				"id",
			),
		).toBeUndefined();
		expect(
			alwaysOfferedRegistrationReturn(
				offeringDoc("new-case", { formPostSubmit: "firstMenu" }),
				OFFERED,
				launch,
				"id",
			),
		).toBeUndefined();
	});
});

describe("selectionsAfterRegistrationReturn", () => {
	const elsewhere = { caseType: "household", cases: [{ caseId: "h1" }] };
	it("chooses the new case in the host and clears every menu the frame does not select in", () => {
		expect(
			selectionsAfterRegistrationReturn(
				{ [HOST]: { caseType: "patient", cases: [] }, [OTHER]: elsewhere },
				{
					screen: { kind: "menu", moduleUuid: HOST },
					selectingModuleUuids: [HOST],
				},
				HOST,
				"patient",
				{ caseId: "new-case-id", caseName: "Ada" },
			),
		).toEqual({
			[HOST]: {
				caseType: "patient",
				cases: [{ caseId: "new-case-id", caseName: "Ada" }],
			},
		});
	});

	it("keeps the selection of a menu the frame selects in that is not the host", () => {
		expect(
			selectionsAfterRegistrationReturn(
				{ [OTHER]: elsewhere },
				{
					screen: { kind: "menu", moduleUuid: HOST },
					selectingModuleUuids: [OTHER],
				},
				HOST,
				"patient",
				undefined,
			),
		).toEqual({ [OTHER]: elsewhere });
	});
});
