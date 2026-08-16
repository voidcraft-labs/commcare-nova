import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	collectTranslationUnits,
	proseText,
	translationUnitIdSchema,
} from "@/lib/domain";
import { runValidation } from "../runner";

describe("translation overlay validation", () => {
	it("rejects orphan units, wrong value kinds, and changed current references", () => {
		const answerUuid = testUuid("translation-answer");
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
								f({ kind: "text", id: "name", uuid: answerUuid }),
								f({
									kind: "label",
									id: "greeting",
									label: {
										parts: [
											{ kind: "text", text: "Hello " },
											{ kind: "field-ref", uuid: answerUuid },
										],
									},
								}),
							],
						},
					],
				},
			],
		});
		const units = collectTranslationUnits(doc);
		const appName = units.find((unit) => unit.role === "app-name");
		const greeting = units.find(
			(unit) =>
				unit.role === "field-label" && unit.context.fieldId === "greeting",
		);
		expect(appName).toBeDefined();
		expect(greeting).toBeDefined();
		if (appName === undefined || greeting === undefined) return;
		const orphan = translationUnitIdSchema.parse("tu1:orphan");
		doc.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: {
				es: {
					[orphan]: {
						value: "orphan",
						sourceFingerprint: "old",
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
					[appName.id]: {
						value: proseText("Clínica"),
						sourceFingerprint: appName.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
					[greeting.id]: {
						value: proseText("Hola"),
						sourceFingerprint: greeting.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};

		const codes = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(error) => error.code,
		);
		expect(codes).toEqual(
			expect.arrayContaining([
				"TRANSLATION_UNIT_UNKNOWN",
				"TRANSLATION_VALUE_KIND_MISMATCH",
				"TRANSLATION_PROTECTED_CONTENT_CHANGED",
			]),
		);
	});

	it("allows old protected tokens on an out-of-date entry because it is never emitted", () => {
		const answerUuid = testUuid("translation-stale-answer");
		const doc = buildDoc({
			modules: [
				{
					name: "Module",
					forms: [
						{
							name: "Form",
							type: "survey",
							fields: [
								f({ kind: "text", id: "answer", uuid: answerUuid }),
								f({ kind: "label", id: "copy", label: "New copy" }),
							],
						},
					],
				},
			],
		});
		const unit = collectTranslationUnits(doc).find(
			(candidate) =>
				candidate.role === "field-label" &&
				candidate.context.fieldId === "copy",
		);
		expect(unit).toBeDefined();
		if (unit === undefined) return;
		doc.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: {
				es: {
					[unit.id]: {
						value: {
							parts: [{ kind: "field-ref", uuid: answerUuid }],
						},
						sourceFingerprint: "an-older-source-fingerprint",
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};
		const codes = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(error) => error.code,
		);
		expect(codes).not.toContain("TRANSLATION_PROTECTED_CONTENT_CHANGED");
	});

	it("rejects a blank target for a slot whose worker-facing content is required", () => {
		const doc = buildDoc({ appName: "Clinic" });
		const unit = collectTranslationUnits(doc).find(
			(candidate) => candidate.role === "app-name",
		);
		expect(unit).toBeDefined();
		if (unit === undefined) return;
		doc.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: {
				es: {
					[unit.id]: {
						value: "  ",
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};
		const codes = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
			(error) => error.code,
		);
		expect(codes).toContain("TRANSLATION_REQUIRED_CONTENT_BLANK");
	});

	it("rejects a current app-string value that Core cannot round-trip", () => {
		const doc = buildDoc({ appName: "Clinic" });
		const unit = collectTranslationUnits(doc).find(
			(candidate) => candidate.role === "app-name",
		);
		if (unit === undefined) throw new Error("Expected app-name unit.");
		doc.localization = {
			sourceLanguage: "en",
			defaultLanguage: "en",
			languageOrder: ["en", "es"],
			languages: {
				en: { code: "en", name: "English", direction: "ltr" },
				es: { code: "es", name: "Español", direction: "ltr" },
			},
			translations: {
				es: {
					[unit.id]: {
						value: String.raw`Clínica \n literal`,
						sourceFingerprint: unit.sourceFingerprint,
						origin: "human",
						review: "reviewed",
						translatedFrom: "en",
					},
				},
			},
		};

		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "APP_STRING_VALUE_UNREPRESENTABLE",
				}),
			]),
		);
	});
});
