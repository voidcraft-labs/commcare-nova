import { describe, expect, it } from "vitest";
import {
	INSTANCE_READS,
	instanceReadFixture,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import { itextTranslationUnitId } from "@/lib/commcare/xform/itextIds";
import { proseText, translationUnitsById } from "@/lib/domain";
import type { ItextUnit } from "@/lib/domain/expression/types";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { previewFormText } from "../formText";
import { previewLookupData } from "../lookupEvaluation";

/** The fixture app in English and French, with the color question's label
 * and its first choice translated; the second choice is not. */
function bilingual() {
	const built = instanceReadFixture();
	const doc = built.doc;
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "fra"],
		wireCodes: { eng: "en", fra: "fr" },
		translations: { fra: {} },
	};
	const translate = (unit: ItextUnit, text: string) => {
		const translation = translationUnitsById(doc).get(
			itextTranslationUnitId(unit),
		);
		const overlay = doc.localization?.translations.fra;
		if (translation === undefined || overlay === undefined)
			throw new Error("The unit to translate is missing.");
		overlay[translation.id] = {
			value: proseText(text),
			sourceFingerprint: translation.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		};
	};
	translate({ field: INSTANCE_READS.color, role: "field-label" }, "Couleur");
	translate(
		{
			field: INSTANCE_READS.color,
			option: INSTANCE_READS.red,
			role: "select-option-label",
		},
		"Rouge",
	);
	return { ...built, doc };
}

describe("previewFormText", () => {
	it("holds each written entry's text in the language the form shows", () => {
		const { doc } = bilingual();
		const english = previewFormText(doc, INSTANCE_READS.visitForm, "eng");
		const french = previewFormText(doc, INSTANCE_READS.visitForm, "fra");
		expect(english.itext["color-label"]).toBe("Color");
		expect(french.itext["color-label"]).toBe("Couleur");
		expect(french.itext["color-opt0-label"]).toBe("Rouge");
		// An untranslated choice reads the form builder's fill, the source.
		expect(french.itext["color-opt1-label"]).toBe("Blue");
	});

	it("reads the default language when the form names none", () => {
		const { doc } = bilingual();
		expect(
			previewFormText(doc, INSTANCE_READS.visitForm).itext["color-label"],
		).toBe("Color");
	});

	it("writes no entry the XForm leaves out, such as a hint no language holds", () => {
		const { doc } = bilingual();
		const text = previewFormText(doc, INSTANCE_READS.visitForm, "eng");
		expect(Object.hasOwn(text.itext, "color-label")).toBe(true);
		expect(Object.hasOwn(text.itext, "color-hint")).toBe(false);
	});

	it("keys each written select by the path the Preview print names", () => {
		const { doc } = bilingual();
		expect(
			previewFormText(doc, INSTANCE_READS.visitForm, "fra").selects,
		).toEqual({
			"/data/color": [
				["red", "Rouge"],
				["blue", "Blue"],
			],
		});
	});

	it("is what the running form reads in the language it shows", () => {
		const { doc, table, rows } = bilingual();
		const input = buildEngineInput(doc, INSTANCE_READS.visitForm, "fra");
		if (input === undefined) throw new Error("The fixture form is missing.");
		const engine = new FormEngine(
			input,
			"patient",
			undefined,
			null,
			previewLookupData({
				projectRevision: "1",
				definitions: [table],
				rowsByTable: new Map([[table.id, rows]]),
			}),
			{ rows: [], indices: [], locations: [] },
		);
		expect(engine.getState("/data/color_text").value).toBe("Couleur");
		engine.setValue("/data/color", "red");
		expect(engine.getState("/data/color_label").value).toBe("Rouge");
	});
});
