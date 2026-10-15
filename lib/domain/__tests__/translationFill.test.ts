import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import {
	type BlueprintDoc,
	filledProse,
	type LanguageTag,
	makeTranslationUnitId,
	type ProseTemplate,
	proseText,
	type TranslationUnit,
	translationFillSource,
	translationUnitsById,
} from "@/lib/domain";

const FIELD_SPEC_UUID = "fill-field";
const FIELD = testUuid(FIELD_SPEC_UUID);
const WIRE_CODES: Readonly<Record<string, string>> = {
	eng: "en",
	spa: "es",
	fra: "fr",
};

/** A three-language app whose one question has a label and a hint. */
function fixture(options: {
	readonly label: string;
	readonly hint: string;
	readonly sourceLanguage: LanguageTag;
	readonly languageOrder: readonly LanguageTag[];
}): BlueprintDoc {
	const doc = buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Patients",
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({
								uuid: FIELD_SPEC_UUID,
								kind: "text",
								id: "name",
								label: options.label,
								hint: options.hint,
							}),
						],
					},
				],
			},
		],
	});
	doc.localization = {
		sourceLanguage: options.sourceLanguage,
		defaultLanguage: options.languageOrder[0] ?? options.sourceLanguage,
		languageOrder: [...options.languageOrder],
		wireCodes: Object.fromEntries(
			options.languageOrder.map((tag) => [tag, WIRE_CODES[tag] ?? tag]),
		),
		translations: Object.fromEntries(
			options.languageOrder
				.filter((tag) => tag !== options.sourceLanguage)
				.map((tag) => [tag, {}]),
		),
	};
	return doc;
}

function unit(doc: BlueprintDoc, slot: "label" | "hint"): TranslationUnit {
	const found = translationUnitsById(doc).get(
		makeTranslationUnitId("field", FIELD, slot),
	);
	if (found === undefined) throw new Error(`No ${slot} unit`);
	return found;
}

/** Store a current, unreviewed translation of one slot. */
function translate(
	doc: BlueprintDoc,
	language: LanguageTag,
	slot: "label" | "hint",
	value: ProseTemplate,
): void {
	const target = unit(doc, slot);
	const translations = doc.localization?.translations[language];
	if (translations === undefined) throw new Error(`No ${language} overlay`);
	translations[target.id] = {
		value,
		sourceFingerprint: target.sourceFingerprint,
		origin: "human",
		review: "needs-review",
		translatedFrom: doc.localization?.sourceLanguage ?? "eng",
	};
}

describe("filledProse", () => {
	it("gives a blank translation the default language's text", () => {
		const doc = fixture({
			label: "Name",
			hint: "Full name",
			sourceLanguage: "eng",
			languageOrder: ["eng", "spa", "fra"],
		});
		translate(doc, "spa", "label", proseText(""));
		translate(doc, "fra", "label", proseText("Nom"));
		expectAdmittedDoc(doc);

		expect(filledProse(doc, unit(doc, "label"), "spa")).toEqual(
			proseText("Name"),
		);
		expect(translationFillSource(doc, unit(doc, "label"), "spa")).toBe("eng");
		expect(filledProse(doc, unit(doc, "label"), "fra")).toEqual(
			proseText("Nom"),
		);
		expect(translationFillSource(doc, unit(doc, "label"), "fra")).toBe(
			undefined,
		);
	});

	it("fills a blank default-language value from the first translation in language order", () => {
		const doc = fixture({
			label: "Name",
			hint: "",
			sourceLanguage: "eng",
			languageOrder: ["eng", "spa", "fra"],
		});
		translate(doc, "spa", "hint", proseText(""));
		translate(doc, "fra", "hint", proseText("Nom complet"));
		expectAdmittedDoc(doc);

		for (const language of ["eng", "spa"] as const) {
			expect(filledProse(doc, unit(doc, "hint"), language)).toEqual(
				proseText("Nom complet"),
			);
			expect(translationFillSource(doc, unit(doc, "hint"), language)).toBe(
				"fra",
			);
		}
	});

	it("follows the app's default language, not its source language", () => {
		const doc = fixture({
			label: "Name",
			hint: "Full name",
			sourceLanguage: "eng",
			languageOrder: ["spa", "eng", "fra"],
		});
		translate(doc, "spa", "label", proseText("Nombre"));
		translate(doc, "fra", "label", proseText(""));
		expectAdmittedDoc(doc);

		expect(filledProse(doc, unit(doc, "label"), "fra")).toEqual(
			proseText("Nombre"),
		);
		expect(translationFillSource(doc, unit(doc, "label"), "fra")).toBe("spa");
	});

	it("reads a stale translation as the source text it falls back to", () => {
		const doc = fixture({
			label: "Name",
			hint: "Full name",
			sourceLanguage: "eng",
			languageOrder: ["spa", "eng"],
		});
		translate(doc, "spa", "label", proseText(""));
		const field = doc.fields[FIELD];
		if (field === undefined || !("label" in field)) throw new Error("No field");
		field.label = proseText("Full name");
		expectAdmittedDoc(doc);

		// The blank Spanish entry was written for the old source, so Spanish
		// reads today's source text and nothing is filled.
		expect(filledProse(doc, unit(doc, "label"), "spa")).toEqual(
			proseText("Full name"),
		);
		expect(translationFillSource(doc, unit(doc, "label"), "spa")).toBe(
			undefined,
		);
	});

	it("leaves a text blank in every language blank", () => {
		const doc = fixture({
			label: "Name",
			hint: "",
			sourceLanguage: "eng",
			languageOrder: ["eng", "spa", "fra"],
		});
		translate(doc, "spa", "hint", proseText(""));
		expectAdmittedDoc(doc);

		for (const language of ["eng", "spa", "fra"] as const) {
			expect(filledProse(doc, unit(doc, "hint"), language)).toEqual(
				proseText(""),
			);
			expect(translationFillSource(doc, unit(doc, "hint"), language)).toBe(
				undefined,
			);
		}
	});
});
