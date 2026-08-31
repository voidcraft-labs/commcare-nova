import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { CaseOperation, Form } from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../runner";

const KEY = testUuid("11111111-1111-4111-8111-111111111111");
const SESSION_UPDATE = testUuid("22222222-2222-4222-8222-222222222222");
const CREATE = testUuid("33333333-3333-4333-8333-333333333333");
const SESSION_RESTORE = testUuid("88888888-8888-4888-8888-888888888888");
const SOURCE_MODULE = testUuid("44444444-4444-4444-8444-444444444444");
const SOURCE_FORM = testUuid("55555555-5555-4555-8555-555555555555");
const TARGET_MODULE = testUuid("66666666-6666-4666-8666-666666666666");
const TARGET_FORM = testUuid("77777777-7777-4777-8777-777777777777");

function multipleConfig(maximum = 10) {
	return {
		...caseListConfig([{ field: "case_name", header: "Name" }]),
		selection: { kind: "multiple" as const, maximum },
	};
}

function directCollectionLinkDoc(
	caseOperations: readonly CaseOperation[] = [],
) {
	const doc = buildDoc({
		caseTypes: [
			{ name: "patient", properties: [] },
			{ name: "visit", properties: [] },
		],
		modules: [
			{
				uuid: SOURCE_MODULE,
				name: "Source",
				caseType: "patient",
				caseListConfig: multipleConfig(10),
				forms: [
					{
						uuid: SOURCE_FORM,
						name: "Source form",
						type: "followup",
						fields: [f({ uuid: KEY, kind: "text", id: "decision" })],
						formLinks: [
							{
								target: {
									type: "form",
									moduleUuid: TARGET_MODULE,
									formUuid: TARGET_FORM,
								},
							},
						],
					},
				],
			},
			{
				uuid: TARGET_MODULE,
				name: "Target",
				caseType: "patient",
				caseListConfig: multipleConfig(10),
				forms: [
					{
						uuid: TARGET_FORM,
						name: "Target form",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	(doc.forms[SOURCE_FORM] as Form).caseOperations = [...caseOperations];
	return doc;
}

function retypeSelected(condition?: CaseOperation["condition"]): CaseOperation {
	return {
		uuid: SESSION_UPDATE,
		id: "retype_selected",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		retype: "visit",
		...(condition !== undefined && { condition }),
	};
}

function restoreSelected(): CaseOperation {
	return {
		uuid: SESSION_RESTORE,
		id: "restore_selected",
		action: "update",
		caseType: "visit",
		target: { kind: "session" },
		retype: "patient",
	};
}

function codes(doc: ReturnType<typeof buildDoc>): string[] {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
		(error) => error.code,
	);
}

const FANOUT_CHILD_DATUM = "case_id_new_visit_0";

function fanoutExpressionDoc(options: {
	condition?: string;
	datumXpath?: string;
}) {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
			{
				name: "next_case",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: SOURCE_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: multipleConfig(),
				forms: [
					{
						uuid: SOURCE_FORM,
						name: "Create visits",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "visit_name",
								caseWrite: {
									caseType: "visit",
									property: "case_name",
								},
							}),
						],
						formLinks: [
							{
								...(options.condition !== undefined && {
									condition: options.condition,
								}),
								target: {
									type: "form",
									moduleUuid: TARGET_MODULE,
									formUuid: TARGET_FORM,
								},
								...(options.datumXpath !== undefined && {
									datums: [
										{
											name: "case_id_new_next_case_0",
											xpath: options.datumXpath,
										},
									],
								}),
							},
						],
					},
				],
			},
			{
				uuid: TARGET_MODULE,
				name: "Next cases",
				caseType: "next_case",
				forms: [
					{
						uuid: TARGET_FORM,
						name: "Create next case",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								caseWrite: {
									caseType: "next_case",
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

describe("multi-select absolute validation", () => {
	it("requires a batch consumer and refuses a persistent form tile", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...multipleConfig(),
						tile: { persistOnForms: true },
					},
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
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
		expect(codes(doc)).toEqual(
			expect.arrayContaining([
				"MULTI_SELECT_NO_BATCH_CONSUMER",
				"MULTI_SELECT_PERSISTENT_TILE",
			]),
		);
	});

	it("lets a form-less case-list parent hand the complete set to a compatible child", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Choose patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: multipleConfig(5),
					forms: [],
				},
				{
					name: "Review patients",
					caseType: "patient",
					caseListConfig: multipleConfig(5),
					forms: [
						{
							name: "Review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const [parentUuid, childUuid] = doc.moduleOrder;
		doc.modules[childUuid].parentModuleUuid = parentUuid;

		expect(codes(doc)).not.toContain("MULTI_SELECT_NO_BATCH_CONSUMER");

		doc.modules[childUuid].caseListConfig = multipleConfig(4);
		expect(codes(doc)).toContain("MULTI_SELECT_NO_BATCH_CONSUMER");
	});

	it("rejects singular primary writes and shared selected-case expressions", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "note", label: proseText("Note") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: multipleConfig(),
					forms: [
						{
							name: "Review",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "note",
									caseWrite: { caseType: "patient", property: "note" },
									default_value: xp("#patient/case_name"),
								}),
							],
						},
					],
				},
			],
		});
		expect(codes(doc)).toEqual(
			expect.arrayContaining([
				"MULTI_SELECT_PRIMARY_CASE_WRITE",
				"MULTI_SELECT_SHARED_CASE_EXPRESSION",
			]),
		);
	});

	it("rejects authored-key creates, session links, and scope-order reversals", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{ name: "visit", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: multipleConfig(),
					forms: [
						{
							name: "Review",
							type: "followup",
							fields: [f({ uuid: KEY, kind: "text", id: "key" })],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: SESSION_UPDATE,
				id: "update_selected",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: { kind: "session" },
						relationship: "child",
					},
				],
			},
			{
				uuid: CREATE,
				id: "create_visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new", idFrom: KEY },
				name: term(literal("Visit")),
			},
		] satisfies CaseOperation[];

		expect(codes(doc)).toEqual(
			expect.arrayContaining([
				"MULTI_SELECT_SESSION_OPERATION_LINK",
				"MULTI_SELECT_AUTHORED_KEY_CREATE",
				"MULTI_SELECT_OPERATION_ORDER",
			]),
		);
	});

	it("requires a direct destination form to accept the complete set", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: SOURCE_MODULE,
					name: "Source",
					caseType: "patient",
					caseListConfig: multipleConfig(10),
					forms: [
						{
							uuid: SOURCE_FORM,
							name: "Source form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: TARGET_MODULE,
										formUuid: TARGET_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: TARGET_MODULE,
					name: "Target",
					caseType: "patient",
					caseListConfig: multipleConfig(5),
					forms: [
						{
							uuid: TARGET_FORM,
							name: "Target form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		expect(codes(doc)).toContain("FORM_LINK_SELECTION_CARDINALITY");
	});

	it("refuses to carry selected cases after a session operation can change their type", () => {
		const doc = directCollectionLinkDoc([
			retypeSelected(eq(formField(KEY), literal("change"))),
		]);
		const finding = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).find(
			(error) => error.code === "FORM_LINK_SELECTION_CASE_TYPE_CHANGED",
		);

		expect(finding).toMatchObject({
			location: { formUuid: SOURCE_FORM, formName: "Source form" },
			details: {
				expectedCaseType: "patient",
				possibleFinalCaseTypes: "visit, patient",
			},
		});
	});

	it("allows the carry when an inherited unconditional operation restores every changed case", () => {
		const doc = directCollectionLinkDoc([
			retypeSelected(eq(formField(KEY), literal("change"))),
			restoreSelected(),
		]);

		expect(codes(doc)).not.toContain("FORM_LINK_SELECTION_CASE_TYPE_CHANGED");
	});

	it("refuses to carry one phantom child id after creating a child per selected parent", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: SOURCE_MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: multipleConfig(),
					forms: [
						{
							uuid: SOURCE_FORM,
							name: "Create visits",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "visit_name",
									caseWrite: {
										caseType: "visit",
										property: "case_name",
									},
								}),
							],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: TARGET_MODULE,
										formUuid: TARGET_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: TARGET_MODULE,
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListConfig([]),
					forms: [
						{
							uuid: TARGET_FORM,
							name: "Review visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});

		expect(codes(doc)).toContain("MULTI_SELECT_FANOUT_CHILD_DATUM");
		expect(codes(doc)).not.toContain("FORM_LINK_SELECTION_CARDINALITY");
	});

	it("rejects a form-link condition that observes the scalar fanout-child datum", () => {
		const doc = fanoutExpressionDoc({
			condition: `instance('commcaresession')/session/data/${FANOUT_CHILD_DATUM} != ''`,
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "condition",
					datumId: FANOUT_CHILD_DATUM,
				}),
			}),
		]);
	});

	it("rejects a manual carried value that observes the scalar fanout-child datum", () => {
		const doc = fanoutExpressionDoc({
			datumXpath: `instance('commcaresession')/session/data/${FANOUT_CHILD_DATUM}`,
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "carried value",
					datumId: FANOUT_CHILD_DATUM,
				}),
			}),
		]);
	});

	it("rejects a condition that observes every session datum", () => {
		const doc = fanoutExpressionDoc({
			condition: "count(instance('commcaresession')/session/data/*) > 0",
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "condition",
					access: "broad",
				}),
			}),
		]);
	});

	it("rejects a manual carried value that observes every session datum", () => {
		const doc = fanoutExpressionDoc({
			datumXpath: "instance('commcaresession')/session/data/*",
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "carried value",
					access: "broad",
				}),
			}),
		]);
	});

	it("rejects a condition that escapes an exact datum through a sibling axis", () => {
		const doc = fanoutExpressionDoc({
			condition:
				"count(instance('commcaresession')/session/data/unrelated/following-sibling::*) > 0",
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "condition",
					access: "broad",
				}),
			}),
		]);
	});

	it("rejects a filtered session path whose relative predicate observes session data", () => {
		const doc = fanoutExpressionDoc({
			condition:
				"count(instance('commcaresession')/session/context/userid[../../data[count(*) = 2]]) > 0",
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "condition",
					access: "broad",
				}),
			}),
		]);
	});

	it("rejects a filtered carried value whose relative predicate reaches a generated datum sibling", () => {
		const doc = fanoutExpressionDoc({
			datumXpath: `instance('commcaresession')/session/context/userid[../../data/${FANOUT_CHILD_DATUM}/following-sibling::*]`,
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "MULTI_SELECT_FANOUT_CHILD_DATUM",
		);

		expect(findings).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					surface: "carried value",
					access: "broad",
				}),
			}),
		]);
	});

	it("allows plain unrelated exact session reads without filters", () => {
		const doc = fanoutExpressionDoc({
			condition: "instance('commcaresession')/session/data/unrelated = 'yes'",
			datumXpath: "instance('commcaresession')/session/context/userid",
		});

		expect(codes(doc)).not.toContain("MULTI_SELECT_FANOUT_CHILD_DATUM");
	});

	it("preserves ordinary one-case links between different case types", () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "household", properties: [] },
			],
			modules: [
				{
					uuid: SOURCE_MODULE,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([]),
					forms: [
						{
							uuid: SOURCE_FORM,
							name: "Review patient",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: TARGET_MODULE,
										formUuid: TARGET_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: TARGET_MODULE,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([]),
					forms: [
						{
							uuid: TARGET_FORM,
							name: "Inspect household",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});

		expect(codes(doc)).not.toContain("FORM_LINK_SELECTION_CARDINALITY");
	});
});
