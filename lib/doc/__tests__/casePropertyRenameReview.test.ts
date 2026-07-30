import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { reviewCasePropertyRenames } from "@/lib/doc/casePropertyRenameReview";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";

function fixture() {
	return buildDoc({
		appName: "Rename review",
		caseTypes: [
			{
				name: "patient",
				properties: ["case_name", "a", "b"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
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
						name: "Register",
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
								id: "answer_a",
								label: proseText("A"),
								caseWrite: { caseType: "patient", property: "a" },
							}),
						],
					},
				],
			},
		],
	});
}

describe("reviewCasePropertyRenames", () => {
	it("accepts a simultaneous swap and returns exact document impact", () => {
		const reviewed = reviewCasePropertyRenames(
			fixture(),
			[
				{ caseType: "patient", from: "a", to: "b" },
				{ caseType: "patient", from: "b", to: "a" },
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(reviewed.ok).toBe(true);
		if (reviewed.ok) {
			expect(reviewed.impact.totalOccurrences).toBeGreaterThan(0);
			expect(reviewed.impact.byRename).toHaveLength(2);
		}
	});

	it("requires an occupied destination to move in the same relation", () => {
		const reviewed = reviewCasePropertyRenames(
			fixture(),
			[{ caseType: "patient", from: "a", to: "b" }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(reviewed).toEqual({
			ok: false,
			reason:
				"“b” already exists. Add it as another property to rename so no data is overwritten.",
			renameIndex: 0,
		});
	});

	it("locks Nova-managed scalar properties", () => {
		const reviewed = reviewCasePropertyRenames(
			fixture(),
			[{ caseType: "patient", from: "case_name", to: "display_name" }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(reviewed).toEqual({
			ok: false,
			reason: "Nova-managed case properties cannot be renamed.",
			renameIndex: 0,
		});
	});
});
