/**
 * After-submit links in the running preview (`formLinkEvaluation.ts`):
 * which link fires, what a condition can read once the form has closed,
 * and which case the next form opens with.
 *
 * The fixture is a household registration that also creates a patient child
 * case, a household follow-up and close, a patient follow-up, and a survey:
 * enough for every kind of source datum (`case_id`, the registration's own
 * create datum, a subcase datum) and every kind of target.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type DocSpec,
	type FieldSpec,
	f,
	xp,
} from "@/lib/__tests__/docHelpers";
import type { FormLink } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	carriedCaseFor,
	evaluateFormLinks,
	evaluateLinkDatum,
	type FormLinkEvaluationInput,
	formLinkEvalContext,
	sourceSessionDatums,
} from "../formLinkEvaluation";
import type { PreviewSearchSessionValues } from "../identity";

const HOUSEHOLDS = testUuid("mod-households");
const PATIENTS = testUuid("mod-patients");
const REGISTER = testUuid("frm-register");
const UPDATE = testUuid("frm-update");
const CLOSE = testUuid("frm-close");
const VISIT = testUuid("frm-visit");
const FEEDBACK = testUuid("frm-feedback");
const LINK_VISIT = testUuid("lnk-visit");
const LINK_PATIENTS = testUuid("lnk-patients");
const LINK_CLOSE = testUuid("lnk-close");

const SESSION: PreviewSearchSessionValues = {
	context: { userid: "u1", username: "ada" },
	user: { role: "supervisor" },
	userPropertySlugs: {},
};

const writer = (
	id: string,
	caseType: string,
	property: string,
	kind: FieldSpec["kind"] = "text",
): FieldSpec =>
	f({
		kind,
		id,
		label: proseText(id),
		caseWrite: { caseType, property },
	});

function spec(args: { readonly patientsInRepeat?: boolean } = {}): DocSpec {
	return {
		appName: "Households",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: proseText("Village") }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-households",
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-register",
						name: "Register household",
						type: "registration",
						postSubmit: "app_home",
						formLinks: [
							{
								uuid: "lnk-visit",
								condition: "#user/role = 'supervisor'",
								target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
							},
							{
								uuid: "lnk-patients",
								target: { type: "module", moduleUuid: PATIENTS },
							},
						],
						fields: [
							writer("case_name", "household", "case_name"),
							writer("patient_name", "patient", "case_name"),
							...(args.patientsInRepeat === true
								? [
										f({
											kind: "repeat",
											id: "visitors",
											label: proseText("Visitors"),
											children: [
												writer("visitor_name", "patient", "case_name"),
											],
										}),
									]
								: []),
						],
					},
					{
						uuid: "frm-update",
						name: "Update household",
						type: "followup",
						postSubmit: "module",
						formLinks: [
							{
								uuid: "lnk-close",
								condition: "#household/village = 'north'",
								target: {
									type: "form",
									moduleUuid: HOUSEHOLDS,
									formUuid: CLOSE,
								},
							},
						],
						fields: [writer("village", "household", "village")],
					},
					{
						uuid: "frm-close",
						name: "Close household",
						type: "close",
						fields: [writer("village", "household", "village")],
					},
				],
			},
			{
				uuid: "mod-patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [writer("mood", "patient", "mood")],
					},
				],
			},
			{
				uuid: "mod-surveys",
				name: "Surveys",
				forms: [
					{
						uuid: "frm-feedback",
						name: "Feedback",
						type: "survey",
						formLinks: [
							{
								uuid: "lnk-survey",
								target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
								datums: [{ name: "case_id", xpath: "'p-manual'" }],
							},
						],
						fields: [
							f({ kind: "text", id: "comment", label: proseText("Comment") }),
						],
					},
				],
			},
		],
	};
}

function inputFor(
	doc: ReturnType<typeof buildDoc>,
	overrides: Partial<FormLinkEvaluationInput> = {},
): FormLinkEvaluationInput {
	return {
		doc,
		session: SESSION,
		usercase: { role: "supervisor" },
		sessionDatums: new Map(),
		caseData: new Map(),
		...overrides,
	};
}

function nestedPatientDoc(): ReturnType<typeof buildDoc> {
	const doc = buildDoc(spec());
	doc.modules[PATIENTS].parentModuleUuid = HOUSEHOLDS;
	// HQ aligns a child entry against the root module's first form. Put a
	// case-loading form first so the patient's ordinary `case_id` collides
	// with the root selection and becomes `case_id_patient`.
	doc.formOrder[HOUSEHOLDS] = [UPDATE, REGISTER, CLOSE];
	return doc;
}

function linksOf(doc: ReturnType<typeof buildDoc>, formUuid: string) {
	const links = doc.forms[testUuid(formUuid)]?.formLinks;
	if (links === undefined) throw new Error(`${formUuid} has no links`);
	return links;
}

function linkNamed(
	doc: ReturnType<typeof buildDoc>,
	formUuid: string,
	linkUuid: string,
): FormLink {
	const link = linksOf(doc, formUuid).find(
		(candidate) => candidate.uuid === testUuid(linkUuid),
	);
	if (link === undefined) throw new Error(`${linkUuid} is not on ${formUuid}`);
	return link;
}

describe("evaluateFormLinks", () => {
	it("follows the first link whose condition holds", () => {
		const doc = buildDoc(spec());
		const choice = evaluateFormLinks({
			links: linksOf(doc, "frm-register"),
			fallback: "app_home",
			input: inputFor(doc),
		});
		expect(choice).toMatchObject({ kind: "link", index: 0 });
		expect(choice.kind === "link" && choice.link.uuid).toBe(LINK_VISIT);
	});

	it("falls through a false condition to the unconditional link", () => {
		const doc = buildDoc(spec());
		const choice = evaluateFormLinks({
			links: linksOf(doc, "frm-register"),
			fallback: "app_home",
			input: inputFor(doc, { usercase: { role: "nurse" } }),
		});
		expect(choice).toMatchObject({ kind: "link", index: 1 });
		expect(choice.kind === "link" && choice.link.uuid).toBe(LINK_PATIENTS);
	});

	it("reads case properties as they are after the submission", () => {
		const doc = buildDoc(spec());
		const links = linksOf(doc, "frm-update");
		const north = evaluateFormLinks({
			links,
			fallback: "module",
			input: inputFor(doc, {
				caseData: new Map([["household", new Map([["village", "north"]])]]),
			}),
		});
		expect(north.kind === "link" && north.link.uuid).toBe(LINK_CLOSE);
		const south = evaluateFormLinks({
			links,
			fallback: "module",
			input: inputFor(doc, {
				caseData: new Map([["household", new Map([["village", "south"]])]]),
			}),
		});
		expect(south).toEqual({ kind: "fallback", destination: "module" });
	});

	it("reads an absent case property as blank, the device's missing node", () => {
		const doc = buildDoc(spec());
		const choice = evaluateFormLinks({
			links: linksOf(doc, "frm-update"),
			fallback: "module",
			input: inputFor(doc),
		});
		expect(choice).toEqual({ kind: "fallback", destination: "module" });
	});

	it("treats a condition that prints to nothing as unconditional", () => {
		const doc = buildDoc(spec());
		const [first] = linksOf(doc, "frm-update");
		if (first === undefined) throw new Error("fixture has no link");
		const blank: FormLink = { ...first, condition: xp("   ") };
		const choice = evaluateFormLinks({
			links: [blank],
			fallback: "module",
			input: inputFor(doc),
		});
		expect(choice).toMatchObject({ kind: "link", index: 0 });
	});
});

describe("formLinkEvalContext", () => {
	it("serves session context and the source entry's own datums", () => {
		const doc = buildDoc(spec());
		const ctx = formLinkEvalContext(
			inputFor(doc, {
				sessionDatums: new Map([["case_id", { value: "h1" }]]),
			}),
		);
		expect(
			ctx.resolveInstance?.("commcaresession", "/session/context/username"),
		).toEqual({ kind: "supported", value: "ada" });
		expect(
			ctx.resolveInstance?.("commcaresession", "/session/data/case_id"),
		).toEqual({ kind: "supported", value: "h1" });
		// A datum nothing filled is an absent node, not an error.
		expect(
			ctx.resolveInstance?.("commcaresession", "/session/data/usercase_id"),
		).toEqual({ kind: "supported" });
		expect(ctx.resolveInstance?.("casedb", "/casedb/case")).toEqual({
			kind: "unsupported",
		});
	});

	it("refuses to read the closed form", () => {
		const doc = buildDoc(spec());
		const ctx = formLinkEvalContext(inputFor(doc));
		expect(() => ctx.getValue("/data/village")).toThrow(
			/cannot read "\/data\/village"/,
		);
		expect(() => ctx.resolveHashtag("#form/village")).toThrow(
			/cannot read "#form\/village"/,
		);
		expect(() => ctx.resolveHashtag("#case/village")).toThrow(/#case/);
	});

	it("reads #user from the usercase and an unknown namespace as blank", () => {
		const doc = buildDoc(spec());
		const ctx = formLinkEvalContext(inputFor(doc));
		expect(ctx.resolveHashtag("#user/role")).toBe("supervisor");
		expect(ctx.resolveHashtag("#user/missing")).toBe("");
		expect(ctx.resolveHashtag("#clinic/name")).toBe("");
	});
});

describe("sourceSessionDatums", () => {
	it("values a child menu's renamed own-case datum", () => {
		const doc = nestedPatientDoc();
		const datums = sourceSessionDatums(doc, VISIT, {
			caseId: "p1",
			caseName: "Ada",
			childCases: [],
		});
		expect([...datums]).toEqual([
			["case_id_patient", { value: "p1", caseName: "Ada" }],
		]);
	});

	it("values a follow-up's case_id with the case it loaded", () => {
		const doc = buildDoc(spec());
		const datums = sourceSessionDatums(doc, UPDATE, {
			caseId: "h1",
			caseName: "Smith",
			childCases: [],
		});
		expect(datums.get("case_id")).toEqual({ value: "h1", caseName: "Smith" });
	});

	it("values a registration's own create datum and its subcase datum", () => {
		const doc = buildDoc(spec());
		const datums = sourceSessionDatums(doc, REGISTER, {
			caseId: "h9",
			caseName: "Smiths",
			childCases: [{ caseType: "patient", caseId: "p1", caseName: "Pat" }],
		});
		expect(datums.get("case_id_new_household_0")).toEqual({
			value: "h9",
			caseName: "Smiths",
		});
		expect(datums.get("case_id_new_patient_1")).toEqual({
			value: "p1",
			caseName: "Pat",
		});
	});

	it("leaves a subcase datum unvalued when no child of its type was created", () => {
		const doc = buildDoc(spec());
		const datums = sourceSessionDatums(doc, REGISTER, {
			caseId: "h9",
			childCases: [],
		});
		expect(datums.has("case_id_new_household_0")).toBe(true);
		expect(datums.has("case_id_new_patient_1")).toBe(false);
	});

	it("leaves a subcase datum unvalued when a repeat also creates that type", () => {
		// The non-repeat patient and a repeat's patients come back as one list
		// of patient ids; which one the session datum minted cannot be told.
		const doc = buildDoc(spec({ patientsInRepeat: true }));
		const datums = sourceSessionDatums(doc, REGISTER, {
			caseId: "h9",
			childCases: [{ caseType: "patient", caseId: "p1" }],
		});
		expect(datums.has("case_id_new_patient_1")).toBe(false);
	});
});

describe("carriedCaseFor", () => {
	it("carries the selected ancestor from a child source into an ancestor form", () => {
		const doc = nestedPatientDoc();
		const sessionDatums = sourceSessionDatums(
			doc,
			VISIT,
			{
				caseId: "p1",
				caseName: "Ada",
				childCases: [],
			},
			new Map([
				[
					HOUSEHOLDS,
					{
						caseType: "household",
						value: "h1",
						caseName: "Smith household",
					},
				],
			]),
		);
		expect([...sessionDatums]).toEqual([
			["case_id", { value: "h1", caseName: "Smith household" }],
			["case_id_patient", { value: "p1", caseName: "Ada" }],
		]);
		const ancestorTarget: FormLink = {
			uuid: testUuid("nested-ancestor-link"),
			target: { type: "form", moduleUuid: HOUSEHOLDS, formUuid: UPDATE },
		};
		expect(
			carriedCaseFor(inputFor(doc, { sessionDatums }), VISIT, ancestorTarget),
		).toEqual({
			kind: "carried",
			caseId: "h1",
			caseName: "Smith household",
		});
	});

	it("carries a nested target through its renamed selected-case datum", () => {
		const doc = nestedPatientDoc();
		const sessionDatums = sourceSessionDatums(doc, VISIT, {
			caseId: "p1",
			caseName: "Ada",
			childCases: [],
		});
		const automatic: FormLink = {
			uuid: testUuid("nested-auto-link"),
			target: { type: "form", moduleUuid: PATIENTS, formUuid: VISIT },
		};
		const input = inputFor(doc, { sessionDatums });
		expect(carriedCaseFor(input, VISIT, automatic)).toEqual({
			kind: "carried",
			caseId: "p1",
			caseName: "Ada",
		});

		const manual: FormLink = {
			...automatic,
			uuid: testUuid("nested-manual-link"),
			datums: [{ name: "case_id_patient", xpath: xp("'p-manual'") }],
		};
		expect(carriedCaseFor(input, VISIT, manual)).toEqual({
			kind: "carried",
			caseId: "p-manual",
		});
	});

	it("carries nothing into a module target", () => {
		const doc = buildDoc(spec());
		expect(
			carriedCaseFor(
				inputFor(doc),
				REGISTER,
				linkNamed(doc, "frm-register", "lnk-patients"),
			),
		).toEqual({ kind: "none" });
	});

	it("carries the created child into a follow-up on the child's type", () => {
		const doc = buildDoc(spec());
		const submission = {
			caseId: "h9",
			childCases: [{ caseType: "patient", caseId: "p1", caseName: "Pat" }],
		};
		const input = inputFor(doc, {
			sessionDatums: sourceSessionDatums(doc, REGISTER, submission),
		});
		expect(
			carriedCaseFor(
				input,
				REGISTER,
				linkNamed(doc, "frm-register", "lnk-visit"),
			),
		).toEqual({ kind: "carried", caseId: "p1", caseName: "Pat" });
	});

	it("carries a blank id when the matched datum was never valued", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: sourceSessionDatums(doc, REGISTER, {
				caseId: "h9",
				childCases: [],
			}),
		});
		expect(
			carriedCaseFor(
				input,
				REGISTER,
				linkNamed(doc, "frm-register", "lnk-visit"),
			),
		).toEqual({ kind: "carried", caseId: "" });
	});

	it("carries the loaded case from a follow-up into another form of its module", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: sourceSessionDatums(doc, UPDATE, {
				caseId: "h1",
				caseName: "Smith",
				childCases: [],
			}),
		});
		expect(
			carriedCaseFor(input, UPDATE, linkNamed(doc, "frm-update", "lnk-close")),
		).toEqual({ kind: "carried", caseId: "h1", caseName: "Smith" });
	});

	it("carries the registered case into a follow-up of the same type", () => {
		const doc = buildDoc(spec());
		const link: FormLink = {
			uuid: testUuid("lnk-update"),
			target: { type: "form", moduleUuid: HOUSEHOLDS, formUuid: UPDATE },
		};
		const input = inputFor(doc, {
			sessionDatums: sourceSessionDatums(doc, REGISTER, {
				caseId: "h9",
				caseName: "Smiths",
				childCases: [],
			}),
		});
		expect(carriedCaseFor(input, REGISTER, link)).toEqual({
			kind: "carried",
			caseId: "h9",
			caseName: "Smiths",
		});
	});

	it("evaluates a manual case_id datum, and reads a missing one as blank", () => {
		const doc = buildDoc(spec());
		const manual = linkNamed(doc, "frm-feedback", "lnk-survey");
		expect(carriedCaseFor(inputFor(doc), FEEDBACK, manual)).toEqual({
			kind: "carried",
			caseId: "p-manual",
		});
		const unnamed: FormLink = {
			...manual,
			datums: [{ name: "other", xpath: xp("'x'") }],
		};
		expect(carriedCaseFor(inputFor(doc), FEEDBACK, unnamed)).toEqual({
			kind: "carried",
			caseId: "",
		});
	});

	it("lets a manual datum read the source entry's own session datums", () => {
		const doc = buildDoc(spec());
		const input = inputFor(doc, {
			sessionDatums: sourceSessionDatums(doc, REGISTER, {
				caseId: "h9",
				childCases: [{ caseType: "patient", caseId: "p1" }],
			}),
		});
		expect(
			evaluateLinkDatum(
				{
					name: "case_id",
					xpath: xp(
						"instance('commcaresession')/session/data/case_id_new_patient_1",
					),
				},
				input,
			),
		).toBe("p1");
	});
});
