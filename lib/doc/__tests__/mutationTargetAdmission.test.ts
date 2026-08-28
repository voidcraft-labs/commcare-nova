import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { proseText } from "@/lib/domain/prose";

function fixture() {
	return buildDoc({
		appId: "app",
		appName: "App",
		modules: [
			{
				name: "Module",
				forms: [
					{
						name: "Form",
						type: "survey",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
							}),
						],
					},
				],
			},
		],
	});
}

describe("mutationTargetsInvalid scalar field admission", () => {
	it("accepts a scalar edit for a live field of the expected kind", () => {
		const doc = fixture();
		const uuid = testUuid(Object.keys(doc.fields)[0]);
		expect(
			mutationTargetsInvalid(doc, [
				{
					kind: "updateField",
					uuid,
					targetKind: "text",
					patch: { id: "nickname" },
				},
			]),
		).toBe(false);
	});

	it("rejects missing and kind-drifted scalar edit targets", () => {
		const doc = fixture();
		const uuid = testUuid(Object.keys(doc.fields)[0]);
		expect(
			mutationTargetsInvalid(doc, [
				{
					kind: "updateField",
					uuid: testUuid("missing"),
					targetKind: "text",
					patch: { id: "nickname" },
				},
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{
					kind: "updateField",
					uuid,
					targetKind: "date",
					patch: { id: "nickname" },
				},
			]),
		).toBe(true);
	});
});
