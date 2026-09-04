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
 *     a child record's `parent_type`, a field's `caseWrite.caseType`, a
 *     `#<type>/…` hashtag in an XPath or prose slot, and a predicate
 *     AST leaf naming the type;
 *   - a type still owned by another module needs no cascade at all.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	planCaseTypeRetirementOnRemove,
	planCaseTypeRetirementOnRetype,
} from "@/lib/doc/caseTypeRetirement";
import {
	type BlueprintDoc,
	hiddenSearchInputDef,
	type ProseTemplate,
	type SearchInputDef,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	matchesPattern,
	now,
	ownerLocationAtLevel,
	prop,
	subcasePath,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

function prose(...parts: ProseTemplate["parts"]): ProseTemplate {
	return { parts };
}

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
	patientSearchInputs?: readonly SearchInputDef[];
	patientAssignedCasesReference?: boolean;
	patientModuleDisplayReference?: boolean;
	patientFormDisplayReference?: boolean;
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
					...(overrides?.patientSearchInputs && {
						searchInputs: [...overrides.patientSearchInputs],
					}),
				},
				...(overrides?.patientModuleDisplayReference && {
					displayCondition: eq(prop("visit", "case_name"), literal("open")),
				}),
				...(overrides?.patientAssignedCasesReference && {
					caseSearchConfig: {
						excludedOwnerIds: {
							kind: "term",
							term: prop("visit", "case_name"),
						},
					},
				}),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						...(overrides?.patientFormDisplayReference && {
							displayCondition: eq(prop("visit", "case_name"), literal("open")),
						}),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
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
								label: proseText("Name"),
								caseWrite: {
									caseType: "visit",
									property: "case_name",
								},
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
	it("blocks when a reverse location owner names the retiring owner case type", () => {
		const doc = twoModuleDoc();
		const patientModule = moduleUuidByName(doc, "Patients");
		const formUuid = doc.formOrder[patientModule]?.[0];
		if (formUuid === undefined) throw new Error("patient form missing");
		doc.forms[formUuid].caseOperations = [
			{
				uuid: testUuid("reverse-owner-retirement"),
				id: "reverse_owner",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				owner: term(ownerLocationAtLevel(testUuid("facility-level"), "visit")),
			},
		];
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);
		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references.join(" ")).toMatch(/owner.*visit|visit.*owner/i);
	});

	it("blocks when an automation runs on the retiring case type", () => {
		const doc = twoModuleDoc();
		const automationUuid = testUuid("retirement-automation");
		doc.automations = {
			[automationUuid]: {
				uuid: automationUuid,
				kind: "case-update",
				name: "Close stale visits",
				caseType: "visit",
				criteriaOperator: "all",
				criteria: [],
				setupOnlyCriteria: [],
				updates: [],
				closeCase: true,
			},
		};
		doc.automationOrder = [automationUuid];

		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toContain(
			'automation "Close stale visits" uses the "visit" case type',
		);
		expect(plan.userMessage).toMatch(/update or remove.*first/i);
	});

	it("blocks on module and form display-condition case-type references", () => {
		const doc = twoModuleDoc({
			patientModuleDisplayReference: true,
			patientFormDisplayReference: true,
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);
		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toContain(
			'the display condition on module "Patients" reads a "visit" property',
		);
		expect(plan.references).toContain(
			'form "Register patient" (module "Patients") reads a "visit" property in its "form_display_condition" condition',
		);
	});

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
			{ kind: "retireCaseType", caseType: "visit" },
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
									label: proseText("Name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
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
			mutations: [{ kind: "retireCaseType", caseType: "patient" }],
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
					label: proseText("Visit note"),
					caseWrite: { caseType: "visit", property: "visit_note" },
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
			'field "visit_note" in form "Register patient" (module "Patients") saves to it (caseWrite.caseType)',
		]);
	});

	it("two-voice split: message keeps the authored slot, userMessage is jargon-free", () => {
		// The same blocked verdict feeds the SA `{ error }` envelope (verbose
		// `message` — the exact `caseWrite.caseType` slot, the `#type/…`
		// reference shape) AND the builder toast (`userMessage` — neither).
		const doc = twoModuleDoc({
			patientExtraFields: [
				f({
					kind: "text",
					id: "summary",
					label: prose(
						{ kind: "text", text: "Last visit was " },
						{
							kind: "case-ref",
							caseType: "visit",
							property: "case_name",
						},
					),
					caseWrite: { caseType: "visit", property: "summary" },
				}),
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);
		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;

		// SA voice keeps the detail it self-corrects on.
		expect(plan.message).toContain("(caseWrite.caseType)");
		expect(plan.message).toContain("#visit/");

		// Builder voice carries neither — same facts, no wire vocabulary.
		expect(plan.userMessage).not.toContain("caseWrite.caseType");
		expect(plan.userMessage).not.toContain("#visit/");
		expect(plan.userMessage).toContain('field "summary"');
		expect(plan.userMessage).toContain("saves to it");
		// The user frame drops the "retire / manages / retarget" wording for
		// plain English — the SA `message` keeps it (asserted above).
		expect(plan.userMessage).toContain("Update or remove");
		expect(plan.userMessage).not.toContain("retire");
	});

	it("blocks on a #type/… hashtag in another module's XPath and prose slots", () => {
		const doc = twoModuleDoc({
			patientExtraFields: [
				f({
					kind: "text",
					id: "summary",
					label: prose(
						{ kind: "text", text: "Last visit was " },
						{
							kind: "case-ref",
							caseType: "visit",
							property: "case_name",
						},
					),
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
		expect(plan.userMessage).toContain(
			'the Cases available setting on module "Patients" uses "visit" information',
		);
		expect(plan.userMessage).not.toContain("case-list filter");
		expect(plan.userMessage).not.toContain('a "visit" property');
	});

	it("blocks on the Search prompt slots that name the type, in the search field's voice", () => {
		// The choice list's row rule, a required condition, a check, and a
		// hidden value are each a registry slot the walk visits. The gate
		// refuses a case read in the Search-screen slots, so the fixture
		// reaches them through a relation walk and a `prop` leaf directly to
		// prove the walk is total over the registry rather than trusting that.
		const tableId = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
		const doc = twoModuleDoc({
			patientSearchInputs: [
				simpleSearchInputDef(
					testUuid("search-region"),
					"region",
					"Region",
					"select",
					"village",
					{
						via: subcasePath("parent", "visit"),
						options: {
							kind: "lookup",
							tableId,
							valueColumnId:
								"018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId,
							labelColumnId:
								"018f3e8a-7b2c-7def-8abc-0000000000b2" as LookupColumnId,
							filter: eq(prop("visit", "case_name"), literal("x")),
						},
					},
				),
				simpleSearchInputDef(
					testUuid("search-name"),
					"full_name",
					"",
					"text",
					"case_name",
					{
						required: { when: eq(prop("visit", "case_name"), literal("x")) },
						validation: {
							rule: eq(prop("visit", "case_name"), literal("x")),
							message: "No.",
						},
					},
				),
				hiddenSearchInputDef(
					testUuid("search-site"),
					"site",
					"Site",
					term(prop("visit", "case_name")),
				),
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toEqual([
			'search input "region" on module "Patients" walks through "visit"',
			'search input "region" on module "Patients" narrows its choices with a "visit" property',
			'search input "full_name" on module "Patients" is required under a "visit" property',
			'search input "full_name" on module "Patients" is checked against a "visit" property',
			'search input "site" on module "Patients" is worked out from a "visit" property',
		]);
		expect(plan.userMessage).toContain(
			'the row rule for search field "Region" on module "Patients" uses "visit" information',
		);
		expect(plan.userMessage).toContain(
			'the required condition for search field "full_name" on module "Patients" uses "visit" information',
		);
		expect(plan.userMessage).toContain(
			'the check on search field "full_name" on module "Patients" uses "visit" information',
		);
		expect(plan.userMessage).toContain(
			'the hidden value search field "Site" on module "Patients" uses "visit" information',
		);
		expect(plan.userMessage).not.toContain("search_input");
	});

	it("retires the record past a choice prompt and a hidden value that name nothing", () => {
		// A select prompt's property is contextual (it follows its own
		// module's type), and a hidden input carries no property at all, so
		// neither holds the retiring record.
		const tableId = "018f3e8a-7b2c-7def-8abc-0000000000a1" as LookupTableId;
		const doc = twoModuleDoc({
			patientSearchInputs: [
				simpleSearchInputDef(
					testUuid("search-village"),
					"village",
					"Village",
					"multi-select",
					"village",
					{
						options: {
							kind: "lookup",
							tableId,
							valueColumnId:
								"018f3e8a-7b2c-7def-8abc-0000000000b1" as LookupColumnId,
							labelColumnId:
								"018f3e8a-7b2c-7def-8abc-0000000000b2" as LookupColumnId,
						},
						required: {},
						validation: {
							rule: matchesPattern(
								{ kind: "input", searchInputUuid: testUuid("search-village") },
								"^[a-z_]+$",
							),
							message: "Pick a village.",
						},
					},
				),
				hiddenSearchInputDef(
					testUuid("search-time"),
					"search_time",
					"Search time",
					now(),
				),
			],
		});
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan).toMatchObject({
			kind: "retire",
			caseType: "visit",
			mutations: [{ kind: "retireCaseType", caseType: "visit" }],
		});
	});

	it("describes the assigned cases setting without exposing its stored slot name", () => {
		const doc = twoModuleDoc({ patientAssignedCasesReference: true });
		const plan = planCaseTypeRetirementOnRemove(
			doc,
			moduleUuidByName(doc, "Visits"),
		);

		expect(plan.kind).toBe("blocked");
		if (plan.kind !== "blocked") return;
		expect(plan.references).toEqual([
			'the assigned cases setting on module "Patients" reads "visit" information',
		]);
		expect(plan.userMessage).not.toContain("excluded_owner_ids");
		expect(plan.userMessage).not.toContain("excluded owners");
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
									label: proseText("Visit for #visit/case_name"),
									caseWrite: {
										caseType: "visit",
										property: "case_name",
									},
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
			'field "case_name" in form "Record visit" (module "Visits") saves to it (caseWrite.caseType)',
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
							fields: [
								f({
									kind: "text",
									id: "comments",
									label: proseText("Comments"),
								}),
							],
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
			mutations: [{ kind: "retireCaseType", caseType: "visit" }],
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
			mutations: [{ kind: "retireCaseType", caseType: "visit" }],
		});
	});
});
