// Tests the question media slot's language-files reading against both what
// the store holds and what the inspector's projected field shows.
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { projectLocalizedField, proseText } from "@/lib/domain";
import { mediaSlotHoldsLanguageFiles } from "../mediaSlotModel";

const FIELD = testUuid("note");

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: FIELD,
								id: "note",
								kind: "text",
								label: proseText("Note"),
								label_media: {
									image: testMediaAssetId("shared"),
									mediaByLanguage: {
										fra: { image: testMediaAssetId("french") },
									},
								},
								help_media: { image: testMediaAssetId("help") },
							}),
						],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			wireCodes: { eng: "en", fra: "fr" },
			translations: { fra: {} },
		};
	});
}

describe("mediaSlotHoldsLanguageFiles", () => {
	it("reads a language's own files from the stored field", () => {
		const doc = fixture();
		expect(mediaSlotHoldsLanguageFiles(doc.fields[FIELD], "label_media")).toBe(
			true,
		);
		expect(mediaSlotHoldsLanguageFiles(doc.fields[FIELD], "help_media")).toBe(
			false,
		);
	});

	it("can't tell from the source language's projection, which the inspector shows", () => {
		const doc = fixture();
		expect(
			mediaSlotHoldsLanguageFiles(
				projectLocalizedField(doc, "eng", FIELD),
				"label_media",
			),
		).toBe(false);
	});
});
