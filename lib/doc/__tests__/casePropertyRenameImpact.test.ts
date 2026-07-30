import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { casePropertyRenameImpact } from "@/lib/doc/casePropertyRenameImpact";
import {
	applyCasePropertyRenamePlan,
	casePropertyCarrierNames,
	planCasePropertyRenames,
} from "@/lib/doc/casePropertyRenames";
import type { BlueprintDoc } from "@/lib/doc/types";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const MODULE = testUuid("51000000-0000-4000-8000-000000000000");
const FORM = testUuid("52000000-0000-4000-8000-000000000000");
const FIELD_A = testUuid("53000000-0000-4000-8000-000000000001");
const FIELD_B = testUuid("53000000-0000-4000-8000-000000000002");
const OPERATION = testUuid("54000000-0000-4000-8000-000000000000");
const COLUMN = testUuid("55000000-0000-4000-8000-000000000000");

function fixture(): BlueprintDoc {
	return {
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
						target: { kind: "session" },
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

	it("keeps simultaneous swap totals in parity with the apply walker", () => {
		const doc = fixture();
		const renames = [
			{ caseType: "patient", from: "a", to: "b" },
			{ caseType: "patient", from: "b", to: "a" },
		] as const;
		const impact = casePropertyRenameImpact(doc, renames);
		const planned = planCasePropertyRenames(doc, {
			kind: "renameCaseProperties",
			renames: [...renames],
		});
		if (!planned.ok) throw new Error("Expected a valid swap.");
		const next = produce(doc, (draft) => {
			applyCasePropertyRenamePlan(draft, planned.plan);
		});
		const before = new Map(
			casePropertyCarrierNames(doc).map((entry) => [entry.path, entry.value]),
		);
		const changed = casePropertyCarrierNames(next).filter(
			(entry) => before.get(entry.path) !== entry.value,
		);

		expect(impact.totalOccurrences).toBe(changed.length);
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
