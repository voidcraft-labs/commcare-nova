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
			field: f({
				kind: "hidden",
				id: "value",
				calculate: "concat('a', 'b')",
				caseWrite: { caseType: "patient", property: "value" },
			}),
			expected: [],
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
	])("$name", ({ field, expected }) => {
		const base = admittedCaseListDoc({ fields: [field] });
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
	const attachment = (mode: "attachment" | "url"): FieldSpec =>
		f({
			kind: "image",
			id: "photo",
			label: "Photo",
			caseWrite: { caseType: "patient", property: "photo", mode },
		});
	it("reports only the absent scalar slot for attachment-only writers at every column kind", () => {
		const base = admittedCaseListDoc({ fields: [attachment("attachment")] });
		for (const column of [
			plainColumn(id, "photo", "Photo"),
			phoneColumn(id, "photo", "Phone"),
		]) {
			const result = findings(withColumns(base, [column]));
			expect(result.map((error) => error.code)).toEqual([
				"CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT",
			]);
			expect(result[0].details?.columnUuid).toBe(id);
		}
	});
	it("admits URL capture and a scalar property written alongside its attachment", () => {
		const url = admittedCaseListDoc({ fields: [attachment("url")] });
		expect(
			findings(withColumns(url, [plainColumn(id, "photo", "Photo")])),
		).toEqual([]);
		const scalar = admittedCaseListDoc({
			fields: [attachment("attachment")],
			additionalForms: [
				{
					name: "Update photo note",
					type: "followup",
					fields: [
						f({
							kind: "text",
							id: "photo_note",
							label: "Note",
							caseWrite: { caseType: "patient", property: "photo" },
						}),
					],
				},
			],
		});
		expect(
			findings(withColumns(scalar, [plainColumn(id, "photo", "Photo")])),
		).toEqual([]);
	});
});
