import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { incrementalValidationScope } from "@/lib/doc/incrementalValidationScope";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid, type Mutation } from "@/lib/doc/types";
import type { CaseOperation, Form } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";

const PARENT_MODULE = asUuid("00000000-0000-4000-8000-000000000101");
const CHILD_MODULE = asUuid("00000000-0000-4000-8000-000000000102");
const CHILD_FORM = asUuid("00000000-0000-4000-8000-000000000103");
const LINK_MODULE = asUuid("00000000-0000-4000-8000-000000000104");
const LINK_FORM = asUuid("00000000-0000-4000-8000-000000000105");
const SECOND_MODULE = asUuid("00000000-0000-4000-8000-000000000106");
const SECOND_FORM = asUuid("00000000-0000-4000-8000-000000000107");

const MULTIPLE_FIVE = { kind: "multiple" as const, maximum: 5 };

function expectCommitParity(
	doc: ReturnType<typeof buildDoc>,
	mutations: Mutation[],
) {
	const absolute = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	const incremental = mutationCommitVerdictWithPrevalidation(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(incremental).toEqual(absolute);
	return absolute;
}

function fixture() {
	const doc = buildDoc({
		appName: "Incremental validation",
		modules: [
			{
				name: "Visit",
				forms: [
					{
						name: "Visit form",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name" }),
							f({ kind: "text", id: "age" }),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	if (moduleUuid === undefined) throw new Error("fixture module missing");
	const formUuid = doc.formOrder[moduleUuid]?.[0];
	if (formUuid === undefined) throw new Error("fixture form missing");
	const fieldUuid = doc.fieldOrder[formUuid]?.[0];
	if (fieldUuid === undefined) throw new Error("fixture field missing");
	return { doc, moduleUuid, formUuid, fieldUuid };
}

describe("incrementalValidationScope", () => {
	it("scopes ordinary field patches and option-owned edits to their form", () => {
		const { doc, formUuid, fieldUuid } = fixture();
		const scope = incrementalValidationScope(doc, [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { id: "full_name" },
			},
		]);
		expect(scope).toEqual({ formUuids: new Set([formUuid]) });
	});

	it("rechecks module rules when a case destination changes", () => {
		const { doc, moduleUuid, formUuid, fieldUuid } = fixture();
		const scope = incrementalValidationScope(doc, [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { caseWrite: { caseType: "person", property: "name" } },
			},
		]);
		expect(scope).toEqual({
			moduleUuids: new Set([moduleUuid]),
			formUuids: new Set([formUuid]),
		});
	});

	it("rechecks operation forms whose inferred writer types a case destination can change", () => {
		const doc = buildDoc({
			appName: "Writer and operation dependency",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "nickname", label: "Nickname", data_type: "text" },
						{ name: "mixed", label: "Mixed" },
					],
				},
			],
			modules: [
				{
					name: "Author",
					caseType: "patient",
					forms: [
						{
							name: "Edit field",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "nickname",
									caseWrite: {
										caseType: "patient",
										property: "nickname",
									},
								}),
							],
						},
					],
				},
				{
					name: "Automation",
					caseType: "patient",
					forms: [
						{
							name: "Run operation",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const authorModuleUuid = doc.moduleOrder[0];
		const operationModuleUuid = doc.moduleOrder[1];
		if (authorModuleUuid === undefined || operationModuleUuid === undefined) {
			throw new Error("operation dependency modules missing");
		}
		const authorFormUuid = doc.formOrder[authorModuleUuid]?.[0];
		const operationFormUuid = doc.formOrder[operationModuleUuid]?.[0];
		const fieldUuid =
			authorFormUuid === undefined
				? undefined
				: doc.fieldOrder[authorFormUuid]?.[0];
		if (
			authorFormUuid === undefined ||
			operationFormUuid === undefined ||
			fieldUuid === undefined
		) {
			throw new Error("operation dependency fixture missing");
		}
		const operation: CaseOperation = {
			uuid: asUuid("00000000-0000-4000-8000-000000000077"),
			id: "write_mixed",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [{ property: "mixed", value: term(literal(7)) }],
		};
		doc.forms[operationFormUuid] = {
			...doc.forms[operationFormUuid],
			caseOperations: [operation],
		} as Form;
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: {
					caseWrite: { caseType: "patient", property: "mixed" },
				},
			},
		];

		expect(incrementalValidationScope(doc, mutations)).toEqual({
			moduleUuids: new Set(doc.moduleOrder),
			formUuids: new Set([authorFormUuid, operationFormUuid]),
		});
		const absolute = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const incremental = mutationCommitVerdictWithPrevalidation(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(absolute.ok).toBe(false);
		expect(incremental).toEqual(absolute);
		if (!absolute.ok) {
			expect(absolute.findings.map((finding) => finding.code)).toContain(
				"CASE_OPERATION_EXPRESSION_TYPE",
			);
		}
	});

	it("unions form and module footprints across a safe batch", () => {
		const { doc, moduleUuid, formUuid, fieldUuid } = fixture();
		const scope = incrementalValidationScope(doc, [
			{
				kind: "setFieldMedia",
				fieldUuid,
				slot: "label",
				media: null,
			},
			{
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { filter: null },
			},
		]);
		expect(scope).toEqual({
			moduleUuids: new Set([moduleUuid]),
			formUuids: new Set([formUuid]),
		});
	});

	it("uses the bounded dependency closure for selection edits and unions it across the batch", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: PARENT_MODULE,
					name: "Choose patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [],
				},
				{
					uuid: CHILD_MODULE,
					name: "Review patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
				{
					uuid: LINK_MODULE,
					name: "Linked workflow",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [
						{
							uuid: LINK_FORM,
							name: "Continue",
							type: "followup",
							fields: [f({ kind: "text", id: "decision" })],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: CHILD_MODULE,
										formUuid: CHILD_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: SECOND_MODULE,
					name: "Second workflow",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: SECOND_FORM,
							name: "Second review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		doc.modules[CHILD_MODULE].parentModuleUuid = PARENT_MODULE;

		expect(
			incrementalValidationScope(doc, [
				{
					kind: "setCaseListMeta",
					uuid: CHILD_MODULE,
					patch: { selection: { kind: "multiple", maximum: 4 } },
				},
				{
					kind: "setCaseListMeta",
					uuid: SECOND_MODULE,
					patch: { selection: MULTIPLE_FIVE },
				},
			]),
		).toEqual({
			moduleUuids: new Set([CHILD_MODULE, PARENT_MODULE, SECOND_MODULE]),
			formUuids: new Set([CHILD_FORM, LINK_FORM, SECOND_FORM]),
		});
	});

	it("uses app-only scope for presentation scalars", () => {
		const { doc } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{ kind: "setAppName", name: "Renamed" },
			]),
		).toEqual({});
	});

	it("scopes ordinary form and module settings to the owning module", () => {
		const { doc, moduleUuid, formUuid } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: { postSubmit: "app_home" },
				},
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { purpose: "Collect visit information" },
				},
			]),
		).toEqual({
			moduleUuids: new Set([moduleUuid]),
			formUuids: new Set([formUuid]),
		});
	});

	it("falls back when form/module changes alter cross-form session shape", () => {
		const { doc, moduleUuid, formUuid } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: { type: "followup" },
				},
			]),
		).toBeUndefined();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { caseType: "person" },
				},
			]),
		).toBeUndefined();
	});

	it("falls back to the absolute gate for structural or cross-scope work", () => {
		const { doc, fieldUuid } = fixture();
		const conversion = {
			kind: "convertField",
			uuid: fieldUuid,
			toKind: "int",
		} satisfies Mutation;
		expect(incrementalValidationScope(doc, [conversion])).toBeUndefined();
		expect(
			incrementalValidationScope(doc, [
				{ kind: "setAppName", name: "Renamed" },
				conversion,
			]),
		).toBeUndefined();
	});

	it("falls back when a target cannot be placed in the proven footprint", () => {
		const { doc } = fixture();
		expect(
			incrementalValidationScope(doc, [
				{
					kind: "updateField",
					uuid: asUuid("00000000-0000-4000-8000-000000000099"),
					targetKind: "text",
					patch: { id: "missing" },
				},
			]),
		).toBeUndefined();
	});

	it("matches the absolute gate for accepted and rejected field edits", () => {
		const { doc, fieldUuid } = fixture();
		for (const id of ["full_name", "age"]) {
			const mutations: Mutation[] = [
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { id },
				},
			];
			const absolute = mutationCommitVerdict(
				doc,
				mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			const incremental = mutationCommitVerdictWithPrevalidation(
				doc,
				mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(incremental.ok).toBe(absolute.ok);
			if (!absolute.ok && !incremental.ok) {
				expect(incremental.findings.map((finding) => finding.code)).toEqual(
					absolute.findings.map((finding) => finding.code),
				);
			}
		}
	});

	it("matches the absolute gate when changing between one and several cases", () => {
		for (const startsMultiple of [false, true]) {
			const config = caseListConfig([{ field: "case_name", header: "Name" }]);
			if (startsMultiple) config.selection = MULTIPLE_FIVE;
			const doc = buildDoc({
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "note", label: "Note" }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: config,
						forms: [
							{
								name: "Review",
								type: "followup",
								fields: [
									f({
										kind: "text",
										id: "note",
										caseWrite: {
											caseType: "patient",
											property: "note",
										},
									}),
								],
							},
						],
					},
				],
			});
			const moduleUuid = doc.moduleOrder[0];
			const mutation: Mutation = {
				kind: "setCaseListMeta",
				uuid: moduleUuid,
				patch: { selection: startsMultiple ? null : MULTIPLE_FIVE },
			};

			expect(expectCommitParity(doc, [mutation]).ok).toBe(true);
		}
	});

	it("matches the absolute gate when a destination maximum becomes too small", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: LINK_MODULE,
					name: "Source",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: { kind: "multiple", maximum: 10 },
					},
					forms: [
						{
							uuid: LINK_FORM,
							name: "Source form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
							formLinks: [
								{
									target: {
										type: "form",
										moduleUuid: CHILD_MODULE,
										formUuid: CHILD_FORM,
									},
								},
							],
						},
					],
				},
				{
					uuid: CHILD_MODULE,
					name: "Target",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: { kind: "multiple", maximum: 10 },
					},
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Target form",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		const verdict = expectCommitParity(doc, [
			{
				kind: "setCaseListMeta",
				uuid: CHILD_MODULE,
				patch: { selection: MULTIPLE_FIVE },
			},
		]);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "FORM_LINK_SELECTION_CARDINALITY",
						location: expect.objectContaining({ formUuid: LINK_FORM }),
					}),
				]),
			);
		}
	});

	it("matches the absolute gate when a child no longer accepts its parent's complete selection", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: PARENT_MODULE,
					name: "Choose patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [],
				},
				{
					uuid: CHILD_MODULE,
					name: "Review patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						selection: MULTIPLE_FIVE,
					},
					forms: [
						{
							uuid: CHILD_FORM,
							name: "Review",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		});
		doc.modules[CHILD_MODULE].parentModuleUuid = PARENT_MODULE;
		const verdict = expectCommitParity(doc, [
			{
				kind: "setCaseListMeta",
				uuid: CHILD_MODULE,
				patch: { selection: { kind: "multiple", maximum: 4 } },
			},
		]);

		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: "MULTI_SELECT_NO_BATCH_CONSUMER",
						location: expect.objectContaining({ moduleUuid: PARENT_MODULE }),
					}),
				]),
			);
		}
	});

	it("matches the absolute gate when a writer changes another module's case list", () => {
		const doc = buildDoc({
			appName: "Writer dependency",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "nickname", header: "Nickname" },
					]),
					forms: [
						{
							name: "Update patient",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "nickname",
									caseWrite: {
										caseType: "patient",
										property: "nickname",
									},
								}),
							],
						},
					],
				},
				{
					name: "Patient records",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "nickname", header: "Nickname" },
					]),
					forms: [],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]]?.[0];
		const fieldUuid = formUuid && doc.fieldOrder[formUuid]?.[0];
		if (fieldUuid === undefined) throw new Error("writer fixture missing");
		const mutations: Mutation[] = [
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { caseWrite: null },
			},
		];
		const absolute = mutationCommitVerdict(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		const incremental = mutationCommitVerdictWithPrevalidation(
			doc,
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(absolute.ok).toBe(false);
		expect(incremental).toEqual(absolute);
	});
});
