/**
 * Case-type-record retirement planner — the cascade that keeps "stop
 * tracking this case type" satisfiable under the single commit rule.
 *
 * The contract under test:
 *   - removing a case type's LAST owning module retires the record in
 *     the same batch when nothing else names the type;
 *   - the removed module's own subtree never counts as a reference (it
 *     goes with the removal), but on a RETYPE the module stays and its
 *     references block;
 *   - every reference class blocks with a person-readable description:
 *     a child record's `parent_type`, a field's `case_property_on`, a
 *     `#<type>/…` hashtag in an XPath or prose slot, and a predicate
 *     AST leaf naming the type;
 *   - a type still owned by another module needs no cascade at all.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	planCaseTypeRetirementOnRemove,
	planCaseTypeRetirementOnRetype,
} from "@/lib/doc/caseTypeRetirement";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";

const PATIENT_RECORD = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Name" },
		{ name: "village", label: "Village" },
	],
};

const VISIT_RECORD = {
	name: "visit",
	properties: [{ name: "case_name", label: "Name" }],
};

/** Two modules, two records; the visit module is visit's only owner. */
function twoModuleDoc(overrides?: {
	visitParent?: string;
	patientExtraFields?: ReturnType<typeof f>[];
	patientFilter?: boolean;
}): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		caseTypes: [
			PATIENT_RECORD,
			{
				...VISIT_RECORD,
				...(overrides?.visitParent && {
					parent_type: overrides.visitParent,
				}),
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(overrides?.patientFilter && {
						filter: eq(prop("visit", "case_name"), literal("x")),
					}),
				},
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							...(overrides?.patientExtraFields ?? []),
						],
					},
				],
			},
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Record visit",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "visit",
							}),
						],
					},
				],
			},
		],
	});
}

function moduleUuidByName(doc: BlueprintDoc, name: string): Uuid {
	const uuid = doc.moduleOrder.find((u) => doc.modules[u]?.name === name);
	if (!uuid) throw new Error(`no module named ${name} in fixture`);
	return uuid;
}

describe("planCaseTypeRetirementOnRemove", () => {
	it("retires the record when the removed module is its last owner and nothing references it", () => {
		const doc = twoModuleDoc();
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("retire");
		if (plan.kind !== "retire") return;
		expect(plan.caseType).toBe("visit");
		expect(plan.mutations).toEqual([
			{ kind: "setCaseTypes", caseTypes: [PATIENT_RECORD] },
		]);
	});

	it("retires the only record to null — the same empty-catalog shape a fresh app is born with", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [PATIENT_RECORD],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Patients"),
		);

		expect(plan).toMatchObject({
			kind: "retire",
			mutations: [{ kind: "setCaseTypes", caseTypes: null }],
		});
	});

	it("needs no cascade when another module still manages the type", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [PATIENT_RECORD],
			modules: [
				{ name: "Patients A", caseType: "patient" },
				{ name: "Patients B", caseType: "patient" },
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Patients A"),
		);
		expect(plan).toEqual({ kind: "none" });
	});

	it("needs no cascade when the module has no case type or the type has no record", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [PATIENT_RECORD],
			modules: [
				{ name: "Surveys" },
				{ name: "Ghost typed", caseType: "unrecorded" },
			],
		});
		expect(
			planCaseTypeRetirementOnRemove(doc, moduleUuidByName(doc, "Surveys")),
		).toEqual({ kind: "none" });
		expect(
			planCaseTypeRetirementOnRemove(doc, moduleUuidByName(doc, "Ghost typed")),
		).toEqual({ kind: "none" });
	});

	it("blocks when a child record names the retired type as its parent", () => {
		// Removing "Patients" orphans the patient record, and the visit
		// record's `parent_type: "patient"` still names it.
		const doc = twoModuleDoc({ visitParent: "patient" });
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Patients"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.caseType).toBe("patient");
		expect(plan.references).toEqual([
			'case type "visit" declares "patient" as its parent',
		]);
		expect(plan.message).toContain('Removing module "Patients"');
		expect(plan.message).toContain("Remove or retarget");
	});

	it("blocks when a field in ANOTHER module still saves to the type", () => {
		const doc = twoModuleDoc({
			patientExtraFields: [
				f({
					kind: "text",
					id: "visit_note",
					label: "Visit note",
					case_property_on: "visit",
				}),
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toEqual([
			'field "visit_note" in form "Register patient" (module "Patients") saves to it (case_property_on)',
		]);
	});

	it("blocks on a #type/… hashtag in another module's XPath and prose slots", () => {
		const doc = twoModuleDoc({
			patientExtraFields: [
				f({
					kind: "text",
					id: "summary",
					label: "Last visit was #visit/case_name",
					relevant: "#visit/case_name != ''",
				}),
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toEqual([
			'field "summary" in form "Register patient" (module "Patients") references #visit/… in its "relevant" expression',
			'field "summary" in form "Register patient" (module "Patients") references #visit/… in its "label" text',
		]);
	});

	it("blocks on a predicate AST leaf naming the type in another module's case-list filter", () => {
		const doc = twoModuleDoc({ patientFilter: true });
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toEqual([
			'the case-list filter on module "Patients" reads a "visit" property',
		]);
	});

	it("never counts the removed module's OWN subtree — its references go with it", () => {
		// The visit module's own registration field writes to "visit";
		// removing the module takes that field with it, so it must not
		// block its own removal. (`twoModuleDoc`'s visit form has exactly
		// that shape, and the happy-path test above already retires — this
		// pins the exclusion against a label ref too.)
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [PATIENT_RECORD, VISIT_RECORD],
			modules: [
				{ name: "Patients", caseType: "patient" },
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							name: "Record visit",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Visit for #visit/case_name",
									case_property_on: "visit",
									relevant: "#visit/case_name != ''",
								}),
							],
						},
					],
				},
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);
		expect(plan.kind).toBe("retire");
	});
});

describe("planCaseTypeRetirementOnRetype", () => {
	it("blocks when the module's OWN fields still save to the old type — they stay behind", () => {
		const doc = twoModuleDoc();
		const plan = planCaseTypeRetirementOnRetype(
			doc,
			moduleUuidByName(doc, "Visits"),
			"patient",
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.caseType).toBe("visit");
		expect(plan.references).toEqual([
			'field "case_name" in form "Record visit" (module "Visits") saves to it (case_property_on)',
		]);
		expect(plan.message).toContain(
			'Changing module "Visits" to case type "patient"',
		);
	});

	it("retires the old record when the retyped module carries no reference to it", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [PATIENT_RECORD, VISIT_RECORD],
			modules: [
				{ name: "Patients", caseType: "patient" },
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							name: "Feedback",
							type: "survey",
							fields: [f({ kind: "text", id: "comments", label: "Comments" })],
						},
					],
				},
			],
		});
		const plan = planCaseTypeRetirementOnRetype(
			doc,
			moduleUuidByName(doc, "Visits"),
			"patient",
		);

		expect(plan).toMatchObject({
			kind: "retire",
			caseType: "visit",
			mutations: [{ kind: "setCaseTypes", caseTypes: [PATIENT_RECORD] }],
		});
	});

	it("needs no cascade when the type is unchanged", () => {
		const doc = twoModuleDoc();
		expect(
			planCaseTypeRetirementOnRetype(
				doc,
				moduleUuidByName(doc, "Visits"),
				"visit",
			),
		).toEqual({ kind: "none" });
	});

	it("a CLEAR (caseType → undefined) plans the same retirement as a retype", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [VISIT_RECORD],
			modules: [{ name: "Visits", caseType: "visit" }],
		});
		const plan = planCaseTypeRetirementOnRetype(
			doc,
			moduleUuidByName(doc, "Visits"),
			undefined,
		);
		expect(plan).toMatchObject({
			kind: "retire",
			mutations: [{ kind: "setCaseTypes", caseTypes: null }],
		});
	});
});
