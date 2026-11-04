/**
 * What "may not run" means for an after-submit destination
 * (`lib/domain/afterSubmit.ts`). The emitted fallback is HQ's: it conjoins
 * the negation of every non-blank link `xpath`, so the otherwise agrees
 * with the wire only if "may not run" is exactly "has a condition, or
 * carries a value onto a single-case selection" (the held-case guard). The
 * plausible failures are guarding a several-case selection, which names a
 * selection rather than a case, or guarding automatic matching, which
 * carries the source's own cases.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	afterSubmitCanGoHome,
	type BlueprintDoc,
	type FormLink,
	formLinkMayNotRun,
	formOtherwiseReachable,
	guardedLinkDatums,
	type Uuid,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";

const PATIENTS = testUuid("after-submit-patients");
const REFERRALS = testUuid("after-submit-referrals");
const GROUPS = testUuid("after-submit-groups");
const VISIT = testUuid("after-submit-visit");
const REFER = testUuid("after-submit-refer");
const GROUP_VISIT = testUuid("after-submit-group-visit");
const SURVEY = testUuid("after-submit-survey");

function afterSubmitDoc(): BlueprintDoc {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: PATIENTS,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([]),
				forms: [
					{ uuid: VISIT, name: "Visit", type: "followup" },
					{ uuid: SURVEY, name: "Feedback", type: "survey" },
				],
			},
			{
				uuid: REFERRALS,
				name: "Referrals",
				caseType: "patient",
				caseListConfig: caseListConfig([]),
				forms: [{ uuid: REFER, name: "Refer", type: "followup" }],
			},
			{
				uuid: GROUPS,
				name: "Groups",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([]),
					selection: { kind: "multiple", maximum: 5 },
				},
				forms: [{ uuid: GROUP_VISIT, name: "Group visit", type: "followup" }],
			},
		],
	});
}

const carried = (module: Uuid) => ({
	name: { kind: "selected-case" as const, module },
	xpath: term(literal("patient-id")),
});

const toRefer: FormLink["target"] = {
	type: "form",
	moduleUuid: REFERRALS,
	formUuid: REFER,
};

describe("formLinkMayNotRun", () => {
	it("holds for a destination with a condition", () => {
		const doc = afterSubmitDoc();
		expect(
			formLinkMayNotRun(doc, VISIT, {
				target: toRefer,
				condition: term(literal("true")),
			}),
		).toBe(true);
	});

	it("holds for a value carried onto a single-case selection", () => {
		const doc = afterSubmitDoc();
		const link = { target: toRefer, datums: [carried(REFERRALS)] };
		expect(guardedLinkDatums(doc, VISIT, link)).toEqual(link.datums);
		expect(formLinkMayNotRun(doc, VISIT, link)).toBe(true);
	});

	it("does not hold for a value carried onto a several-case selection", () => {
		const doc = afterSubmitDoc();
		const link = {
			target: {
				type: "form" as const,
				moduleUuid: GROUPS,
				formUuid: GROUP_VISIT,
			},
			datums: [carried(GROUPS)],
		};
		expect(guardedLinkDatums(doc, VISIT, link)).toEqual([]);
		expect(formLinkMayNotRun(doc, VISIT, link)).toBe(false);
	});

	it("does not hold for automatic matching with no condition", () => {
		const doc = afterSubmitDoc();
		expect(formLinkMayNotRun(doc, VISIT, { target: toRefer })).toBe(false);
		expect(
			formLinkMayNotRun(doc, VISIT, { target: { type: "this-form" } }),
		).toBe(false);
	});

	it("guards a value this-form carries onto the source form's own selection", () => {
		const doc = afterSubmitDoc();
		expect(
			formLinkMayNotRun(doc, VISIT, {
				target: { type: "this-form" },
				datums: [carried(PATIENTS)],
			}),
		).toBe(true);
	});
});

describe("afterSubmitCanGoHome", () => {
	it("goes home from a form without destinations whose after-submit is the app home", () => {
		const doc = afterSubmitDoc();
		expect(afterSubmitCanGoHome(doc, SURVEY)).toBe(true);
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(false);
		doc.forms[VISIT].postSubmit = "app_home";
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(true);
	});

	it("never goes home when every destination runs every time", () => {
		const doc = afterSubmitDoc();
		doc.forms[VISIT].formLinks = [
			{ uuid: testUuid("after-submit-link-1"), target: toRefer },
		];
		expect(formOtherwiseReachable(doc, VISIT)).toBe(false);
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(false);
	});

	it("goes home when a destination may not run and no otherwise is set", () => {
		const doc = afterSubmitDoc();
		doc.forms[VISIT].formLinks = [
			{
				uuid: testUuid("after-submit-link-1"),
				target: toRefer,
				condition: term(literal("true")),
			},
		];
		expect(formOtherwiseReachable(doc, VISIT)).toBe(true);
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(true);
	});

	it("does not go home when a built-in otherwise or an every-time link otherwise runs in their place", () => {
		const doc = afterSubmitDoc();
		doc.forms[VISIT].formLinks = [
			{
				uuid: testUuid("after-submit-link-1"),
				target: toRefer,
				condition: term(literal("true")),
			},
		];
		doc.forms[VISIT].otherwise = { kind: "destination", destination: "module" };
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(false);
		doc.forms[VISIT].otherwise = {
			kind: "link",
			uuid: testUuid("after-submit-otherwise"),
			target: { type: "this-form" },
		};
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(false);
	});

	it("never goes home beside a destination that runs every time, whatever else may not run", () => {
		const doc = afterSubmitDoc();
		doc.forms[VISIT].formLinks = [
			{ uuid: testUuid("after-submit-link-1"), target: toRefer },
			{
				uuid: testUuid("after-submit-link-2"),
				target: toRefer,
				condition: term(literal("true")),
			},
		];
		expect(formOtherwiseReachable(doc, VISIT)).toBe(true);
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(false);
		doc.forms[VISIT].otherwise = {
			kind: "link",
			uuid: testUuid("after-submit-otherwise"),
			target: toRefer,
			datums: [carried(REFERRALS)],
		};
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(false);
	});

	it("goes home when the otherwise link's own carried case may be missing", () => {
		const doc = afterSubmitDoc();
		doc.forms[VISIT].formLinks = [
			{
				uuid: testUuid("after-submit-link-1"),
				target: toRefer,
				condition: term(literal("true")),
			},
		];
		doc.forms[VISIT].otherwise = {
			kind: "link",
			uuid: testUuid("after-submit-otherwise"),
			target: toRefer,
			datums: [carried(REFERRALS)],
		};
		expect(afterSubmitCanGoHome(doc, VISIT)).toBe(true);
	});
});
