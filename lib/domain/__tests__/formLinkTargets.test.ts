/**
 * Which menus a form may link to, and what a link's target resolves to
 * (`lib/domain/formLinkTargets.ts`). The plausible failure is a reading of
 * HQ's form settings page that drifts: `menuTargetOffered` restates
 * `corehq/apps/app_manager/views/forms.py::_get_linkable_forms_context`,
 * which lists a root menu always and a submenu only from a submenu whose
 * parent's `case_type` equals the target's parent's. The lane holds the
 * validator's verdicts to HQ's own page; these hold Nova's reading.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	formLinkDestination,
	menuTargetOffered,
	nearestOfferedMenu,
	resolveFormLinkTarget,
} from "@/lib/domain";

const HOUSEHOLDS = testUuid("targets-households");
const MEMBERS = testUuid("targets-members");
const CLINICS = testUuid("targets-clinics");
const STAFF = testUuid("targets-staff");
const SURVEYS = testUuid("targets-surveys");
const SURVEY_CHILD = testUuid("targets-survey-child");
const OTHER_SURVEYS = testUuid("targets-other-surveys");
const OTHER_SURVEY_CHILD = testUuid("targets-other-survey-child");
const VISIT = testUuid("targets-visit");

/**
 * Two case-typed roots with a child each, under parents of different case
 * types, and two survey roots (no case type) with a child each.
 */
function menusDoc(): BlueprintDoc {
	const caseModule = (uuid: string, name: string, caseType: string) => ({
		uuid,
		name,
		caseType,
		caseListConfig: caseListConfig([]),
		forms: [
			{
				uuid: uuid === MEMBERS ? VISIT : undefined,
				name: `${name} visit`,
				type: "followup" as const,
			},
		],
	});
	const surveyModule = (uuid: string, name: string) => ({
		uuid,
		name,
		forms: [{ name: `${name} survey`, type: "survey" as const }],
	});
	return buildDoc(
		{
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "member", properties: [] },
				{ name: "clinic", properties: [] },
				{ name: "staff", properties: [] },
			],
			modules: [
				caseModule(HOUSEHOLDS, "Households", "household"),
				caseModule(MEMBERS, "Members", "member"),
				caseModule(CLINICS, "Clinics", "clinic"),
				caseModule(STAFF, "Staff", "staff"),
				surveyModule(SURVEYS, "Surveys"),
				surveyModule(SURVEY_CHILD, "Survey child"),
				surveyModule(OTHER_SURVEYS, "Other surveys"),
				surveyModule(OTHER_SURVEY_CHILD, "Other survey child"),
			],
		},
		(doc) => {
			doc.modules[MEMBERS].parentModuleUuid = HOUSEHOLDS;
			doc.modules[STAFF].parentModuleUuid = CLINICS;
			doc.modules[SURVEY_CHILD].parentModuleUuid = SURVEYS;
			doc.modules[OTHER_SURVEY_CHILD].parentModuleUuid = OTHER_SURVEYS;
			doc.moduleOrder = [
				HOUSEHOLDS,
				MEMBERS,
				CLINICS,
				STAFF,
				SURVEYS,
				SURVEY_CHILD,
				OTHER_SURVEYS,
				OTHER_SURVEY_CHILD,
			];
		},
	);
}

describe("menuTargetOffered", () => {
	it("offers a root menu from every menu, a root or a child", () => {
		const doc = menusDoc();
		expect(menuTargetOffered(doc, HOUSEHOLDS, CLINICS)).toBe(true);
		expect(menuTargetOffered(doc, MEMBERS, CLINICS)).toBe(true);
		expect(menuTargetOffered(doc, MEMBERS, HOUSEHOLDS)).toBe(true);
	});

	it("withholds a child menu from a root menu", () => {
		const doc = menusDoc();
		expect(menuTargetOffered(doc, HOUSEHOLDS, MEMBERS)).toBe(false);
		expect(menuTargetOffered(doc, CLINICS, MEMBERS)).toBe(false);
	});

	it("offers a child from a child whose parent has the same case type", () => {
		const doc = menusDoc();
		expect(menuTargetOffered(doc, MEMBERS, MEMBERS)).toBe(true);
		doc.modules[CLINICS].caseType = "household";
		expect(menuTargetOffered(doc, STAFF, MEMBERS)).toBe(true);
	});

	it("withholds a child from a child whose parent has another case type", () => {
		const doc = menusDoc();
		expect(menuTargetOffered(doc, STAFF, MEMBERS)).toBe(false);
		expect(menuTargetOffered(doc, MEMBERS, STAFF)).toBe(false);
	});

	it("compares survey parents as the empty case type on both sides", () => {
		const doc = menusDoc();
		expect(menuTargetOffered(doc, SURVEY_CHILD, OTHER_SURVEY_CHILD)).toBe(true);
		expect(menuTargetOffered(doc, MEMBERS, OTHER_SURVEY_CHILD)).toBe(false);
		doc.modules[OTHER_SURVEYS].caseType = "";
		expect(menuTargetOffered(doc, SURVEY_CHILD, OTHER_SURVEY_CHILD)).toBe(true);
	});

	it("offers no menu that does not exist", () => {
		expect(
			menuTargetOffered(menusDoc(), HOUSEHOLDS, testUuid("targets-gone")),
		).toBe(false);
	});
});

describe("nearestOfferedMenu", () => {
	it("keeps an offered target", () => {
		const doc = menusDoc();
		expect(nearestOfferedMenu(doc, HOUSEHOLDS, CLINICS)).toBe(CLINICS);
		expect(nearestOfferedMenu(doc, MEMBERS, MEMBERS)).toBe(MEMBERS);
	});

	it("steps up to the parent of a child menu HQ does not offer", () => {
		expect(nearestOfferedMenu(menusDoc(), STAFF, MEMBERS)).toBe(HOUSEHOLDS);
	});

	it("has no answer when that parent is off the menu", () => {
		const doc = menusDoc();
		doc.modules[HOUSEHOLDS].hiddenFromMenu = true;
		expect(nearestOfferedMenu(doc, STAFF, MEMBERS)).toBeUndefined();
	});
});

describe("resolveFormLinkTarget", () => {
	it("resolves this-form to the source form in its own menu", () => {
		const doc = menusDoc();
		expect(resolveFormLinkTarget(doc, VISIT, { type: "this-form" })).toEqual({
			type: "form",
			moduleUuid: MEMBERS,
			formUuid: VISIT,
		});
		expect(formLinkDestination(doc, VISIT, { type: "this-form" })).toEqual({
			kind: "this-form",
			name: "Members visit",
		});
	});

	it("has no answer for this-form on a form in no menu", () => {
		const doc = menusDoc();
		doc.formOrder[MEMBERS] = [];
		expect(
			resolveFormLinkTarget(doc, VISIT, { type: "this-form" }),
		).toBeUndefined();
	});

	it("reads a form or menu target as written", () => {
		const doc = menusDoc();
		const menu = { type: "module" as const, moduleUuid: CLINICS };
		expect(resolveFormLinkTarget(doc, VISIT, menu)).toEqual(menu);
		expect(formLinkDestination(doc, VISIT, menu)).toEqual({
			kind: "module",
			name: "Clinics",
		});
	});
});
