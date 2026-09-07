import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import {
	planCaseTypeRetirementOnRemove,
	planCaseTypeRetirementOnRetype,
} from "@/lib/doc/caseTypeRetirement";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	hiddenSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	exists,
	literal,
	now,
	ownerLocationAtLevel,
	prop,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const PATIENT = testUuid("retire-patient-module");
const VISIT = testUuid("retire-visit-module");
const PATIENT_FORM = testUuid("retire-patient-form");
const VISIT_FORM = testUuid("retire-visit-form");
const SUMMARY = testUuid("retire-summary");

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Clinic",
		caseTypes: [
			{ name: "patient", properties: [{ name: "village", label: "Village" }] },
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "visit_note", label: "Visit note" },
					{ name: "summary", label: "Summary" },
				],
			},
		],
		modules: [
			{
				uuid: PATIENT,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: PATIENT_FORM,
						name: "Review patient",
						type: "followup",
						fields: [
							f({
								uuid: SUMMARY,
								kind: "text",
								id: "summary",
								label: "Summary",
							}),
						],
					},
				],
			},
			{
				uuid: VISIT,
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: VISIT_FORM,
						name: "Record visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}
function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const result = mutationCommitVerdict(
		doc,
		mutations.map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!result.ok) throw new Error(JSON.stringify(result.findings));
	return result.nextDoc;
}
function remove(doc: BlueprintDoc, moduleUuid = VISIT) {
	assertAdmittedDoc(doc);
	const plan = planCaseTypeRetirementOnRemove(doc, moduleUuid);
	if (plan.kind === "retire") {
		const next = commit(doc, [
			{ kind: "removeModule", uuid: moduleUuid },
			...plan.mutations,
		]);
		expect(next.modules[moduleUuid]).toBeUndefined();
		expect(
			next.caseTypes?.some((type) => type.name === plan.caseType) ?? false,
		).toBe(false);
	}
	return plan;
}
function blocked(doc: BlueprintDoc, moduleUuid = VISIT) {
	const plan = remove(doc, moduleUuid);
	if (plan.kind !== "blocked") throw new Error("expected reference blocker");
	expect(plan.userMessage).toContain("Update or remove");
	return plan;
}
function parent(doc: BlueprintDoc, child: string, parent: string) {
	const type = doc.caseTypes?.find((type) => type.name === child);
	if (!type) throw new Error("missing case type");
	type.parent_type = parent;
}

describe("case type retirement from admitted workflows", () => {
	it("retires the last module's record and preserves unrelated modules and fields", () => {
		const doc = fixture();
		const plan = remove(doc);
		expect(plan).toEqual({
			kind: "retire",
			caseType: "visit",
			mutations: [{ kind: "retireCaseType", caseType: "visit" }],
		});
	});
	it("leaves the record when another module still manages the type", () => {
		const doc = fixture();
		const other = testUuid("retire-other-visit");
		doc.modules[other] = {
			uuid: other,
			id: "more_visits",
			name: "More visits",
			caseType: "visit",
			caseListOnly: true,
			caseListConfig: caseListConfig([{ field: "case_name", header: "Name" }]),
		};
		doc.moduleOrder.push(other);
		doc.formOrder[other] = [];
		expect(remove(doc)).toEqual({ kind: "none" });
		const next = commit(doc, [{ kind: "removeModule", uuid: VISIT }]);
		expect(next.caseTypes?.map((type) => type.name)).toEqual([
			"patient",
			"visit",
		]);
	});
	it("canonicalizes the last record to null while a survey remains", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "visit", properties: [] }],
			modules: [
				{
					uuid: VISIT,
					name: "Visits",
					caseType: "visit",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
				{
					name: "Survey",
					forms: [
						{
							name: "Feedback",
							type: "survey",
							fields: [{ kind: "text", id: "feedback" }],
						},
					],
				},
			],
		});
		const plan = remove(doc);
		if (plan.kind !== "retire") throw new Error("expected retirement");
		expect(
			commit(doc, [{ kind: "removeModule", uuid: VISIT }, ...plan.mutations])
				.caseTypes,
		).toBeNull();
	});
	it("ignores absent module identities and case-free modules", () => {
		const doc = buildDoc({
			modules: [
				{
					uuid: PATIENT,
					name: "Survey",
					forms: [
						{
							name: "Feedback",
							type: "survey",
							fields: [{ kind: "text", id: "feedback" }],
						},
					],
				},
			],
		});
		assertAdmittedDoc(doc);
		expect(planCaseTypeRetirementOnRemove(doc, PATIENT)).toEqual({
			kind: "none",
		});
		expect(planCaseTypeRetirementOnRemove(doc, testUuid("absent"))).toEqual({
			kind: "none",
		});
	});
	it("names the remaining child record that requires the retiring parent", () => {
		const doc = fixture();
		parent(doc, "visit", "patient");
		expect(blocked(doc, PATIENT).references).toEqual([
			'case type "visit" declares "patient" as its parent',
		]);
	});
	it("names an automation that still targets the retiring type", () => {
		const doc = fixture(),
			uuid = testUuid("retire-automation");
		doc.automations = {
			[uuid]: {
				uuid,
				kind: "case-update",
				name: "Close visits",
				caseType: "visit",
				criteriaOperator: "all",
				criteria: [],
				setupOnlyCriteria: [],
				updates: [],
				closeCase: true,
			},
		};
		doc.automationOrder = [uuid];
		expect(blocked(doc).references).toEqual([
			'automation "Close visits" uses the "visit" case type',
		]);
	});
	it("names independent case operations outside the removed module", () => {
		const doc = fixture();
		doc.forms[PATIENT_FORM].caseOperations = [
			{
				uuid: testUuid("retire-create-visit"),
				id: "create_visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: term(literal("Visit")),
			},
		];
		expect(blocked(doc).references).toEqual([
			'case operation "create_visit" in form "Review patient" (module "Patients") targets "visit"',
		]);
	});
	it("names both writers that create a child case in another module", () => {
		const doc = fixture();
		parent(doc, "visit", "patient");
		const nameUuid = testUuid("retire-child-name");
		const next = commit(doc, [
			{
				kind: "addField",
				parentUuid: PATIENT_FORM,
				field: {
					uuid: nameUuid,
					id: "visit_name",
					kind: "text",
					label: proseText("Visit name"),
					caseWrite: { caseType: "visit", property: "case_name" },
				},
			},
			{
				kind: "updateField",
				uuid: SUMMARY,
				targetKind: "text",
				patch: { caseWrite: { caseType: "visit", property: "summary" } },
			},
		]);
		const plan = blocked(next);
		expect(plan.references).toEqual([
			'field "summary" in form "Review patient" (module "Patients") saves to it (caseWrite.caseType)',
			'field "visit_name" in form "Review patient" (module "Patients") saves to it (caseWrite.caseType)',
		]);
		expect(plan.userMessage).toContain('field "summary"');
		expect(plan.userMessage).not.toContain("caseWrite.caseType");
	});
	it("names typed XPath and prose reads of an ancestor case", () => {
		const doc = fixture();
		parent(doc, "patient", "visit");
		const next = commit(doc, [
			{
				kind: "updateField",
				uuid: SUMMARY,
				targetKind: "text",
				patch: {
					relevant: xp("#visit/case_name != ''"),
					label: {
						parts: [
							{ kind: "text", text: "Visit " },
							{ kind: "case-ref", caseType: "visit", property: "case_name" },
						],
					},
				},
			},
		]);
		const plan = blocked(next);
		expect(plan.references).toEqual([
			'case type "patient" declares "visit" as its parent',
			'field "summary" in form "Review patient" (module "Patients") references #visit/… in its "relevant" expression',
			'field "summary" in form "Review patient" (module "Patients") references #visit/… in its "label" text',
		]);
		expect(plan.userMessage).not.toContain("#visit/");
	});
	it("names a case-list relation filter and a search input's child relation", () => {
		const doc = fixture();
		parent(doc, "visit", "patient");
		const config = doc.modules[PATIENT].caseListConfig;
		if (!config) throw new Error("missing list");
		config.filter = exists(subcasePath("parent", "visit"));
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("retire-search"),
				"visit_name",
				"Visit name",
				"text",
				"case_name",
				{ via: subcasePath("parent", "visit") },
			),
		];
		const plan = blocked(doc);
		expect(plan.references).toEqual([
			'the case-list filter on module "Patients" reads a "visit" property',
			'search input "visit_name" on module "Patients" walks through "visit"',
		]);
		expect(plan.userMessage).toContain("Cases available");
		expect(plan.userMessage).toContain('search field "Visit name"');
	});
	it("names a selected-case read that would survive a module retype", () => {
		const doc = fixture();
		doc.forms[VISIT_FORM].displayCondition = eq(
			prop("visit", "case_name"),
			literal("open"),
		);
		assertAdmittedDoc(doc);
		const plan = planCaseTypeRetirementOnRetype(doc, VISIT, "patient");
		if (plan.kind !== "blocked") throw new Error("expected blocker");
		expect(plan.references).toContain(
			'form "Record visit" (module "Visits") reads a "visit" property in its "form_display_condition" condition',
		);
	});
	it("names an owner-to-place hop that reads the current owner during retype", () => {
		const doc = fixture();
		const region = testUuid("retire-region"),
			facility = testUuid("retire-facility");
		doc.organizationLevels = {
			[region]: {
				uuid: region,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none", ownsCases: true },
				addressBook: { reach: "own-branch" },
			},
			[facility]: {
				uuid: facility,
				code: "facility",
				name: "Facility",
				parentLevelUuid: region,
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "none" },
				},
				addressBook: { reach: "shared-branch", fromLevelUuid: region },
			},
		};
		doc.organizationLevelOrder = [region, facility];
		doc.forms[VISIT_FORM].caseOperations = [
			{
				uuid: testUuid("retire-owner-operation"),
				id: "reverse_owner",
				action: "update",
				caseType: "visit",
				target: { kind: "session" },
				owner: term(ownerLocationAtLevel(facility, "visit")),
			},
		];
		assertAdmittedDoc(doc);
		const plan = planCaseTypeRetirementOnRetype(doc, VISIT, "patient");
		if (plan.kind !== "blocked") throw new Error("expected blocker");
		expect(plan.references).toContain(
			'case operation "reverse_owner" in form "Record visit" (module "Visits") derives its owner from "visit"',
		);
	});

	it("permits retirement past a hidden search value that reads no case data", () => {
		const doc = fixture();
		const config = doc.modules[PATIENT].caseListConfig;
		if (!config) throw new Error("missing list");
		config.searchInputs = [
			hiddenSearchInputDef(
				testUuid("retire-search-time"),
				"search_time",
				"Search time",
				now(),
			),
		];
		expect(remove(doc).kind).toBe("retire");
	});
	it("excludes actual typed references inside the module being removed", () => {
		const doc = fixture();
		const fieldUuid = doc.fieldOrder[VISIT_FORM][0];
		const next = commit(doc, [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: {
					label: {
						parts: [
							{ kind: "case-ref", caseType: "visit", property: "case_name" },
						],
					},
				},
			},
		]);
		expect(remove(next).kind).toBe("retire");
	});
	it("blocks a module retype while its own surviving fields still name the old type", () => {
		const doc = fixture();
		assertAdmittedDoc(doc);
		const plan = planCaseTypeRetirementOnRetype(doc, VISIT, "patient");
		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") throw new Error("expected reference blocker");
		expect(plan.references).toEqual([
			'field "case_name" in form "Record visit" (module "Visits") saves to it (caseWrite.caseType)',
		]);
		expect(planCaseTypeRetirementOnRetype(doc, VISIT, "visit")).toEqual({
			kind: "none",
		});
	});
	it.each(["patient", undefined])(
		"retires an unused old record during a survey module change to %s",
		(nextType) => {
			const doc = buildDoc({
				caseTypes: [
					{ name: "visit", properties: [] },
					{ name: "patient", properties: [] },
				],
				modules: [
					{
						uuid: VISIT,
						name: "Survey",
						caseType: "visit",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Feedback",
								type: "survey",
								fields: [{ kind: "text", id: "feedback" }],
							},
						],
					},
				],
			});
			assertAdmittedDoc(doc);
			const plan = planCaseTypeRetirementOnRetype(doc, VISIT, nextType);
			if (plan.kind !== "retire") throw new Error("expected retirement");
			const next = commit(doc, [
				{
					kind: "updateModule",
					uuid: VISIT,
					patch: {
						caseType: nextType ?? null,
						...(nextType === undefined ? { caseListConfig: null } : {}),
					},
				},
				...plan.mutations,
			]);
			expect(next.modules[VISIT].caseType).toBe(nextType);
			expect(next.caseTypes?.map((type) => type.name)).toEqual(["patient"]);
		},
	);
});
