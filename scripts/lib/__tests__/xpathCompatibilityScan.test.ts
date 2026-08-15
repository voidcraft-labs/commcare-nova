import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { scanBlueprintXPathCarriers } from "../xpathCompatibilityScan";

describe("scanBlueprintXPathCarriers", () => {
	it("classifies field and form-link raw XPath without applying the commit gate", () => {
		const moduleUuid = testUuid("scan-module");
		const sourceFormUuid = testUuid("scan-source-form");
		const targetFormUuid = testUuid("scan-target-form");
		const doc = buildDoc({
			modules: [
				{
					uuid: moduleUuid,
					name: "Module",
					forms: [
						{
							uuid: sourceFormUuid,
							name: "Source",
							type: "survey",
							formLinks: [
								{
									condition: "current()/answer = 'yes'",
									target: {
										type: "form",
										moduleUuid,
										formUuid: targetFormUuid,
									},
								},
							],
							fields: [
								f({
									kind: "hidden",
									id: "normalized",
									calculate: "normalize-space(' value ')",
								}),
								f({
									kind: "hidden",
									id: "legacy_context",
									calculate: "here()",
								}),
							],
						},
						{
							uuid: targetFormUuid,
							name: "Target",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "answer",
									label: proseText("Answer"),
								}),
							],
						},
					],
				},
			],
		});

		const calls = scanBlueprintXPathCarriers(doc).flatMap((occurrence) =>
			occurrence.calls.map((call) => ({ path: occurrence.path, ...call })),
		);

		expect(calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "normalize-space",
					javaRosa: "lowered",
					preview: "native",
				}),
				expect.objectContaining({
					name: "here",
					javaRosa: "context-handler",
					preview: "unsupported",
				}),
				expect.objectContaining({
					path: expect.stringContaining("formLinks[0].condition"),
					name: "current",
					javaRosa: "path-initializer",
					preview: "unsupported",
					validPathInitializer: true,
				}),
			]),
		);
	});
});
