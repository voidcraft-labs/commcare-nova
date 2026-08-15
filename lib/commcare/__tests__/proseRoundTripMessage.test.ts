import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { proseText } from "@/lib/domain";

vi.mock("@/lib/tiptap/proseTemplateCodec", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/tiptap/proseTemplateCodec")>();
	return {
		...actual,
		proseTemplateSurvivesTiptapRoundTrip: () => false,
	};
});

describe("prose editor round-trip finding", () => {
	it("does not misdiagnose editor loss as a missing reference", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Clients",
					forms: [
						{
							name: "Follow up",
							type: "survey",
							fields: [
								f({
									kind: "label",
									id: "client_summary",
									label: proseText("Client summary"),
								}),
							],
						},
					],
				},
			],
		});

		const finding = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).find(
			(error) => error.code === "PROSE_EDITOR_ROUND_TRIP_LOSS",
		);
		expect(finding?.message).toBe(
			'Field "client_summary" in "Follow up" (label) contains text or a reference that Nova\'s editor cannot preserve. Rewrite this text using plain text and supported reference parts.',
		);
		expect(finding?.message).not.toContain("doesn't exist");
		expect(finding?.message).not.toContain("typo");
		expect(finding?.message).not.toContain("..");
		if (!finding) throw new Error("expected prose round-trip finding");
		expect(userFacingError(finding)).toBe(
			'The text on "client_summary" in "Follow up" contains something the editor can\'t safely preserve. Re-enter its text and references.',
		);
	});
});
