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
} from "@/lib/domain";

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
		projectValue: (value: LocalizedValue) =>
			typeof value === "string" ? value : projectProseTemplate(value, doc).text,
	};
}
