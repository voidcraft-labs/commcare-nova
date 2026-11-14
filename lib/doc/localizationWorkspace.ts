import {
	type BlueprintDoc,
	collectLocalizedTranslationUnits,
	collectTranslationCoverageDiagnostics,
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	projectProseTemplate,
	resolveAppLanguage,
	type TranslationUnit,
	translationUnitProseSlot,
} from "@/lib/domain";
import { projectFormExpression } from "./expressionText";

/** One immutable snapshot's translation inventory, shared by the language
 * cards, phrase rows, and copy-language action. A new doc creates a new view. */
export function createLocalizationWorkspace(
	doc: BlueprintDoc,
	requestedLanguage: LanguageTag,
) {
	const localization = effectiveAppLocalization(doc.localization);
	const selectedTag = resolveAppLanguage(doc.localization, requestedLanguage);
	const unitsByLanguage = new Map<
		LanguageTag,
		readonly LocalizedTranslationUnit[]
	>();
	const unitsForLanguage = (language: LanguageTag) => {
		let units = unitsByLanguage.get(language);
		if (units === undefined) {
			units = collectLocalizedTranslationUnits(doc, language);
			unitsByLanguage.set(language, units);
		}
		return units;
	};
	return {
		localization,
		selectedTag,
		selectedUnits: unitsForLanguage(selectedTag),
		coverageDiagnostics: collectTranslationCoverageDiagnostics(doc),
		unitsForLanguage,
		/** A value as text: a calculated value prints its formula in the
		 *  unit's prose slot, and reads `[calculated value]` where no unit is
		 *  named. */
		projectValue: (
			value: LocalizedValue,
			unit?: Pick<TranslationUnit, "owner" | "role">,
		) => {
			if (typeof value === "string") return value;
			const slot =
				unit === undefined ? undefined : translationUnitProseSlot(unit);
			return projectProseTemplate(
				value,
				doc,
				slot === undefined
					? undefined
					: {
							value: (part) =>
								projectFormExpression(doc, slot, part.expression, "unavailable")
									.text,
						},
			).text;
		},
	};
}
