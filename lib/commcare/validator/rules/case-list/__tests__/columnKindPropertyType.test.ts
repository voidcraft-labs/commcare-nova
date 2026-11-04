import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { dateColumn, phoneColumn, plainColumn } from "@/lib/domain";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

const id = testUuid("column");
describe("column property semantics at the whole admission gate", () => {
	it.each([
		{
			name: "date writer",
			field: f({
				kind: "date",
				id: "value",
				label: "Value",
				caseWrite: { caseType: "patient", property: "value" },
			}),
			expected: [],
		},
		{
			name: "hidden date inference",
			field: f({
				kind: "hidden",
				id: "value",
				calculate: "today()",
				caseWrite: { caseType: "patient", property: "value" },
			}),
			expected: [],
		},
		{
			name: "honestly unknown hidden inference",
			// A copy of a Hidden Value that has no value: nothing types it.
			field: f({
				kind: "hidden",
				id: "value",
				calculate: "#form/seed",
				caseWrite: { caseType: "patient", property: "value" },
			}),
			others: [f({ kind: "hidden", id: "seed" })],
			expected: [],
		},
		{
			name: "hidden text inference",
			field: f({
				kind: "hidden",
				id: "value",
				calculate: "concat('a', 'b')",
				caseWrite: { caseType: "patient", property: "value" },
			}),
			expected: ["CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH"],
		},
		{
			name: "text writer mismatch",
			field: f({
				kind: "text",
				id: "value",
				label: "Value",
				caseWrite: { caseType: "patient", property: "value" },
			}),
			expected: ["CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH"],
		},
	] as {
		name: string;
		field: FieldSpec;
		others?: FieldSpec[];
		expected: string[];
	}[])("$name", ({ field, others, expected }) => {
		const base = admittedCaseListDoc({ fields: [...(others ?? []), field] });
		const result = findings(
			withColumns(base, [dateColumn(id, "value", "Date", "%Y-%m-%d")]),
		);
		expect(result.map((error) => error.code)).toEqual(expected);
		if (expected.length)
			expect(result[0].details).toMatchObject({
				columnUuid: id,
				resolvedType: "text",
				field: "value",
			});
	});
	it("uses the standard property type for a phone column", () => {
		const result = findings(
			withColumns(admittedCaseListDoc(), [
				phoneColumn(id, "date_opened", "Opened"),
			]),
		);
		expect(result.map((error) => error.code)).toEqual([
			"CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH",
		]);
		expect(result[0].details?.resolvedType).toBe("datetime");
	});
	it("admits a column over the property a capture saves its file's link to", () => {
		const base = admittedCaseListDoc({
			fields: [
				f({
					kind: "image",
					id: "photo",
					label: "Photo",
					caseWrite: { caseType: "patient", property: "photo" },
				}),
			],
		});
		expect(
			findings(withColumns(base, [plainColumn(id, "photo", "Photo")])),
		).toEqual([]);
	});
});
