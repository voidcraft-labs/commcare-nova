import { describe, expect, it } from "vitest";
import {
	TRANSLATION_EVALUATION_CRITERIA,
	TRANSLATION_EVALUATION_FIXTURES,
	TRANSLATION_EVALUATION_SOURCE_LANGUAGES,
	translationEvaluationUnits,
} from "../translation-evaluation-fixtures";

describe("translation evaluation fixtures", () => {
	it("has one unique, structurally valid unit per fixture in every source language", () => {
		for (const language of TRANSLATION_EVALUATION_SOURCE_LANGUAGES) {
			const units = translationEvaluationUnits(language);
			expect(units).toHaveLength(TRANSLATION_EVALUATION_FIXTURES.length);
			expect(new Set(units.map((unit) => unit.id)).size).toBe(units.length);
			expect(units.every((unit) => unit.breadcrumb.length > 0)).toBe(true);
		}
	});

	it("binds every case to known review criteria and exercises protected prose and formatting", () => {
		const knownCriteria = new Set<string>(
			TRANSLATION_EVALUATION_CRITERIA.map((criterion) => criterion.id),
		);
		for (const fixture of TRANSLATION_EVALUATION_FIXTURES) {
			expect(fixture.criterionIds.length).toBeGreaterThan(0);
			expect(
				fixture.criterionIds.every((criterion) => knownCriteria.has(criterion)),
			).toBe(true);
		}
		const english = translationEvaluationUnits("en");
		expect(
			english.some(
				(unit) =>
					typeof unit.source !== "string" &&
					unit.source.parts.some((part) => part.kind !== "text"),
			),
		).toBe(true);
		expect(
			TRANSLATION_EVALUATION_FIXTURES.some(
				(fixture) => (fixture.formattingMarkers?.length ?? 0) > 0,
			),
		).toBe(true);
	});
});
