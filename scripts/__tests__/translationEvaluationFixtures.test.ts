import { describe, expect, it } from "vitest";
import {
	encodeTranslationUnit,
	planTranslationBatches,
	translationBatchOutputSchema,
	translationLanguage,
	translationPromptPayload,
	validateTranslationBatchOutput,
} from "@/lib/agent/translation/translator";
import { type LocalizedValue, parseLanguageTag } from "@/lib/domain";
import {
	TRANSLATION_EVALUATION_CRITERIA,
	TRANSLATION_EVALUATION_FIXTURES,
	TRANSLATION_EVALUATION_SOURCE_LANGUAGES,
	translationEvaluationUnits,
} from "../translation-evaluation-fixtures";

const directions = TRANSLATION_EVALUATION_SOURCE_LANGUAGES.flatMap((source) =>
	TRANSLATION_EVALUATION_SOURCE_LANGUAGES.filter(
		(target) => target !== source,
	).map((target) => ({ source, target })),
);

describe("offline translation evaluation protocol", () => {
	it.each(directions)(
		"carries $source fixtures through the protocol to $target values",
		({ source, target }) => {
			const units = translationEvaluationUnits(source);
			const targets = new Map(
				translationEvaluationUnits(target).map((unit) => [unit.id, unit]),
			);
			const accepted = new Map<string, LocalizedValue>();
			for (const batch of planTranslationBatches(units)) {
				// Exercise the same serializable request and parsed response boundaries
				// as the evaluation script. Candidates are authored fixtures, not model output.
				const payload = translationPromptPayload({
					sourceLanguage: translationLanguage(parseLanguageTag(source)),
					targetLanguage: translationLanguage(parseLanguageTag(target)),
					appObjective: "Household follow-up visits",
					units: batch,
					glossary: [],
				});
				expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
				const output = translationBatchOutputSchema.parse({
					translations: payload.units.map((unit) => {
						const targetUnit = targets.get(unit.unitId);
						if (targetUnit === undefined)
							throw new Error(`Missing target fixture ${unit.unitId}`);
						return {
							unitId: unit.unitId,
							translatedText: encodeTranslationUnit(targetUnit).sourceText,
						};
					}),
				});
				for (const [id, value] of validateTranslationBatchOutput(
					batch,
					output,
				)) {
					expect(accepted.has(id)).toBe(false);
					accepted.set(id, value);
				}
			}
			expect(accepted).toEqual(
				new Map([...targets].map(([id, unit]) => [id, unit.source])),
			);
			expect(accepted.size).toBe(TRANSLATION_EVALUATION_FIXTURES.length);
		},
	);

	it("associates every review row with usable criteria and actual formatting delimiters", () => {
		const criteria = new Set<string>(
			TRANSLATION_EVALUATION_CRITERIA.map((criterion) => criterion.id),
		);
		for (const language of TRANSLATION_EVALUATION_SOURCE_LANGUAGES) {
			const units = translationEvaluationUnits(language);
			for (const [
				index,
				fixture,
			] of TRANSLATION_EVALUATION_FIXTURES.entries()) {
				expect(fixture.criterionIds.length, fixture.key).toBeGreaterThan(0);
				for (const criterion of fixture.criterionIds)
					expect(criteria.has(criterion), fixture.key).toBe(true);
				const unit = units[index];
				if (unit === undefined)
					throw new Error(`Missing source fixture ${fixture.key}`);
				expect(unit.breadcrumb.length, fixture.key).toBeGreaterThan(0);
				const encoded = encodeTranslationUnit(unit);
				for (const marker of fixture.formattingMarkers ?? []) {
					// A missing marker on both sides would make the evaluation's
					// equality check pass vacuously. Require a real formatting signal.
					expect(marker.length, fixture.key).toBeGreaterThan(0);
					expect(
						encoded.sourceText.split(marker).length - 1,
						fixture.key,
					).toBeGreaterThan(0);
				}
				if (fixture.criterionIds.includes("protected-reference")) {
					expect(encoded.protectedTokens.length, fixture.key).toBeGreaterThan(
						0,
					);
					const damaged = encoded.sourceText.replace(
						encoded.protectedTokens[0] ?? "",
						"",
					);
					expect(() =>
						validateTranslationBatchOutput([encoded], {
							translations: [
								{ unitId: encoded.unitId, translatedText: damaged },
							],
						}),
					).toThrow("must preserve protected token");
				}
			}
		}
	});
});
