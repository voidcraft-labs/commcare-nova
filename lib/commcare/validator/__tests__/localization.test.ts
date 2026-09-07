import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	collectTranslationUnits,
	proseText,
	type TranslationEntry,
	type TranslationUnitId,
	translationUnitIdSchema,
} from "@/lib/domain";
import { runValidation } from "../runner";

const ANSWER = testUuid("translation-answer");
function fixture() {
	const doc = buildDoc({
		appName: "Clinic",
		modules: [
			{
				name: "Intake",
				forms: [
					{
						name: "Register",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", uuid: ANSWER }),
							f({
								kind: "label",
								id: "greeting",
								label: {
									parts: [
										{ kind: "text", text: "Hello " },
										{ kind: "field-ref", uuid: ANSWER },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const units = collectTranslationUnits(doc);
	const app = units.find((u) => u.role === "app-name"),
		greeting = units.find(
			(u) => u.context.fieldId === "greeting" && u.role === "field-label",
		);
	if (!app || !greeting) throw new Error("Missing translation units");
	return { doc, app, greeting };
}
function overlay(
	doc: BlueprintDoc,
	id: TranslationUnitId,
	value: TranslationEntry["value"],
	fingerprint: string,
) {
	doc.localization = {
		sourceLanguage: "eng",
		defaultLanguage: "eng",
		languageOrder: ["eng", "spa"],
		translations: {
			spa: {
				[id]: {
					value,
					sourceFingerprint: fingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
}
describe("translation overlay commit validation", () => {
	it.each(["unknown", "kind", "reference", "blank", "locale-escape"] as const)(
		"rejects one isolated %s defect from an admitted document",
		(defect) => {
			const { doc, app, greeting } = fixture();
			const id =
				defect === "unknown"
					? translationUnitIdSchema.parse("tu1:orphan")
					: defect === "reference"
						? greeting.id
						: app.id;
			const value =
				defect === "kind"
					? proseText("Clínica")
					: defect === "reference"
						? proseText("Hola")
						: defect === "blank"
							? "  "
							: defect === "locale-escape"
								? String.raw`Clínica \n literal`
								: "Unknown";
			const expected = {
				unknown: "TRANSLATION_UNIT_UNKNOWN",
				kind: "TRANSLATION_VALUE_KIND_MISMATCH",
				reference: "TRANSLATION_PROTECTED_CONTENT_CHANGED",
				blank: "TRANSLATION_REQUIRED_CONTENT_BLANK",
				"locale-escape": "APP_STRING_VALUE_UNREPRESENTABLE",
			};
			overlay(
				doc,
				id,
				value,
				defect === "reference"
					? greeting.sourceFingerprint
					: app.sourceFingerprint,
			);
			const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(errors.map((e) => e.code)).toEqual([expected[defect]]);
			expect(errors[0].details).toMatchObject({ language: "spa", unitId: id });
		},
	);
	it("admits the same protected-content difference only when its fingerprint is stale", () => {
		const { doc, greeting } = fixture();
		overlay(
			doc,
			greeting.id,
			proseText("Old plain copy"),
			"older-source-fingerprint",
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		overlay(
			doc,
			greeting.id,
			proseText("Old plain copy"),
			greeting.sourceFingerprint,
		);
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((e) => e.code),
		).toEqual(["TRANSLATION_PROTECTED_CONTENT_CHANGED"]);
	});
	it("admits a translated template that preserves the actual reference identity", () => {
		const { doc, greeting } = fixture();
		overlay(
			doc,
			greeting.id,
			{
				parts: [
					{ kind: "text", text: "Hola " },
					{ kind: "field-ref", uuid: ANSWER },
				],
			},
			greeting.sourceFingerprint,
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});
