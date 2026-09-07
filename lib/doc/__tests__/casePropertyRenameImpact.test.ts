import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { casePropertyRenameImpact } from "@/lib/doc/casePropertyRenameImpact";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/doc/types";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("51000000-0000-4000-8000-000000000000");
const FORM = testUuid("52000000-0000-4000-8000-000000000000");
const FIELD_A = testUuid("53000000-0000-4000-8000-000000000001");
const FIELD_B = testUuid("53000000-0000-4000-8000-000000000002");
const OPERATION = testUuid("54000000-0000-4000-8000-000000000000");
const COLUMN = testUuid("55000000-0000-4000-8000-000000000000");

function fixture(): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId: "impact-app",
		appName: "Impact",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: ["a", "b"].map((name) => ({
					name,
					label: proseText(name.toUpperCase()),
					data_type: "text" as const,
				})),
			},
		],
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						{
							uuid: COLUMN,
							kind: "plain",
							field: "a",
							header: "A",
						},
					],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
				},
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "edit_patient",
				name: "Edit patient",
				type: "followup",
				caseOperations: [
					{
						uuid: OPERATION,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: {
							kind: "expression",
							expr: term(literal("other-patient")),
						},
						writes: [{ property: "a", value: term(literal("value")) }],
					},
				],
			},
		},
		fields: {
			[FIELD_A]: {
				uuid: FIELD_A,
				id: "question_a",
				kind: "text",
				label: proseText("A"),
				caseWrite: { caseType: "patient", property: "a" },
			},
			[FIELD_B]: {
				uuid: FIELD_B,
				id: "question_b",
				kind: "text",
				label: proseText("B"),
				caseWrite: { caseType: "patient", property: "b" },
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD_A, FIELD_B] },
		fieldParent: { [FIELD_A]: FORM, [FIELD_B]: FORM },
	};
	assertAdmittedDoc(doc);
	return doc;
}

describe("casePropertyRenameImpact", () => {
	it("groups the exact field, operation, read, and catalog leaves", () => {
		const impact = casePropertyRenameImpact(fixture(), [
			{ caseType: "patient", from: "a", to: "fresh" },
		]);

		expect(impact).toEqual({
			totalOccurrences: 4,
			totalCarriers: 4,
			groups: [
				{ key: "field-writers", occurrences: 1, carriers: 1 },
				{ key: "case-operation-writes", occurrences: 1, carriers: 1 },
				{ key: "typed-reads", occurrences: 1, carriers: 1 },
				{ key: "catalog-declarations", occurrences: 1, carriers: 1 },
			],
			byRename: [
				{
					caseType: "patient",
					from: "a",
					to: "fresh",
					occurrences: 4,
				},
			],
		});
	});

	it("counts six independently observed leaves in an admitted simultaneous swap", () => {
		const doc = fixture();
		const renames = [
			{ caseType: "patient", from: "a", to: "b" },
			{ caseType: "patient", from: "b", to: "a" },
		] as const;
		const impact = casePropertyRenameImpact(doc, renames);
		const verdict = mutationCommitVerdict(
			doc,
			[{ kind: "renameCaseProperties", renames: [...renames] }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		const next = verdict.nextDoc;
		expect(next.fields[FIELD_A]).toMatchObject({
			id: "question_a",
			caseWrite: { caseType: "patient", property: "b" },
		});
		expect(next.fields[FIELD_B]).toMatchObject({
			id: "question_b",
			caseWrite: { caseType: "patient", property: "a" },
		});
		expect(next.forms[FORM].caseOperations?.[0].writes?.[0].property).toBe("b");
		expect(next.modules[MODULE].caseListConfig?.columns[0]).toMatchObject({
			field: "b",
		});
		expect(
			next.caseTypes?.[0].properties.map((property) => property.name),
		).toEqual(["b", "a"]);
		expect(impact.totalOccurrences).toBe(6);
		expect(impact.totalCarriers).toBe(6);
		expect(impact.groups).toEqual([
			{ key: "field-writers", occurrences: 2, carriers: 2 },
			{ key: "case-operation-writes", occurrences: 1, carriers: 1 },
			{ key: "typed-reads", occurrences: 1, carriers: 1 },
			{ key: "catalog-declarations", occurrences: 2, carriers: 2 },
		]);
		expect(impact.byRename).toEqual([
			{ caseType: "patient", from: "a", to: "b", occurrences: 4 },
			{ caseType: "patient", from: "b", to: "a", occurrences: 2 },
		]);
	});
});
