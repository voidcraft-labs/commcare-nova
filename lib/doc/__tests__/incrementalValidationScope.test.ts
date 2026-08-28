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
