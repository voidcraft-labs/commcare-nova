import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { caseWriteChoiceVerdict } from "@/lib/doc/caseWriteChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

function fixture(): { doc: BlueprintDoc; name: Field; notes: Field } {
	const doc = buildDoc({
		appName: "Case write choices",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "case_name",
						label: proseText("Name"),
						data_type: "text",
					},
					{
						name: "notes",
						label: proseText("Notes"),
						data_type: "text",
					},
					{
						name: "nickname",
						label: proseText("Nickname"),
						data_type: "text",
					},
					{
						name: "dob",
						label: proseText("Date of birth"),
						data_type: "date",
					},
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "first_name",
								label: proseText("Name"),
								caseWrite: {
									caseType: "patient",
									property: "case_name",
								},
							}),
							f({
								kind: "text",
								id: "visit_notes",
								label: proseText("Notes"),
								caseWrite: {
									caseType: "patient",
									property: "notes",
								},
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	const [nameUuid, notesUuid] = doc.fieldOrder[formUuid];
	return {
		doc,
		name: doc.fields[nameUuid],
		notes: doc.fields[notesUuid],
	};
}

describe("caseWriteChoiceVerdict", () => {
	it("admits a declared property with no field writer", () => {
		const { doc, notes } = fixture();
		expect(
			caseWriteChoiceVerdict(
				doc,
				notes,
				{ caseType: "patient", property: "nickname" },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({ ok: true });
	});

	it("admits a new property as one complete pair", () => {
		const { doc, notes } = fixture();
		expect(
			caseWriteChoiceVerdict(
				doc,
				notes,
				{ caseType: "patient", property: "preferred_language" },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toEqual({ ok: true });
	});

	it("disables clearing the required registration name writer", () => {
		const { doc, name } = fixture();
		const verdict = caseWriteChoiceVerdict(
			doc,
			name,
			null,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/name|case_name/i);
	});

	it("disables a duplicate writer and a declared type mismatch", () => {
		const { doc, name, notes } = fixture();
		const duplicate = caseWriteChoiceVerdict(
			doc,
			name,
			{ caseType: "patient", property: "notes" },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(duplicate.ok).toBe(false);

		const mismatch = caseWriteChoiceVerdict(
			doc,
			notes,
			{ caseType: "patient", property: "dob" },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) {
			expect(mismatch.reason).toMatch(
				/date|data type|shape|type doesn't match/i,
			);
		}
	});
});
