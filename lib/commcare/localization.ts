// lib/commcare/localization.ts
//
// Read-only Blueprint localization projection for CommCare wire emitters.
// Domain translation units remain the authority for identity, freshness, and
// fallback. Emitters ask this object for one unit in one/all app languages;
// they never walk the overlay or reinterpret review state themselves.

import {
	type AppLanguage,
	type BlueprintDoc,
	effectiveAppLocalization,
	type LanguageCode,
	localizeTranslationUnit,
	type ProseTemplate,
	printProseTemplate,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";

export type WireLanguageMap = Record<string, string>;

export interface CommCareLocalization {
	readonly languages: readonly LanguageCode[];
	readonly sourceLanguage: LanguageCode;
	readonly defaultLanguage: LanguageCode;
	readonly metadata: Readonly<Record<LanguageCode, AppLanguage>>;
	wireText(language: LanguageCode, unitId: TranslationUnitId): string;
	text(language: LanguageCode, unitId: TranslationUnitId): string;
	prose(language: LanguageCode, unitId: TranslationUnitId): ProseTemplate;
	textMap(unitId: TranslationUnitId): WireLanguageMap;
	proseTextMap(unitId: TranslationUnitId): WireLanguageMap;
	proseOrSourceMap(
		unitId: TranslationUnitId | undefined,
		source: ProseTemplate,
	): Readonly<Record<LanguageCode, ProseTemplate>>;
}

/**
 * Build one immutable lookup facade for an emission run. Missing and stale
 * entries intentionally resolve through `localizeTranslationUnit` to the
 * canonical source, which is Nova's authored fallback contract.
 */
export function commCareLocalization(doc: BlueprintDoc): CommCareLocalization {
	const effective = effectiveAppLocalization(doc.localization);
	const units = translationUnitsById(doc);
	const requireUnit = (unitId: TranslationUnitId) => {
		const unit = units.get(unitId);
		if (unit === undefined) {
			throw new Error(
				`CommCare localization references unknown unit ${unitId}.`,
			);
		}
		return unit;
	};
	const value = (language: LanguageCode, unitId: TranslationUnitId) =>
		localizeTranslationUnit(doc, language, requireUnit(unitId)).effective;

	const text = (language: LanguageCode, unitId: TranslationUnitId): string => {
		const localized = value(language, unitId);
		if (typeof localized !== "string") {
			throw new Error(`CommCare localization expected text for ${unitId}.`);
		}
		return localized;
	};
	const prose = (
		language: LanguageCode,
		unitId: TranslationUnitId,
	): ProseTemplate => {
		const localized = value(language, unitId);
		if (typeof localized === "string") {
			throw new Error(`CommCare localization expected prose for ${unitId}.`);
		}
		return localized;
	};
	const wireText = (
		language: LanguageCode,
		unitId: TranslationUnitId,
	): string => {
		const localized = value(language, unitId);
		return typeof localized === "string"
			? localized
			: printProseTemplate(localized, doc);
	};

	return {
		languages: effective.languageOrder,
		sourceLanguage: effective.sourceLanguage,
		defaultLanguage: effective.defaultLanguage,
		metadata: effective.languages,
		wireText,
		text,
		prose,
		textMap(unitId) {
			return Object.fromEntries(
				effective.languageOrder.map((language) => [
					language,
					text(language, unitId),
				]),
			);
		},
		proseTextMap(unitId) {
			return Object.fromEntries(
				effective.languageOrder.map((language) => [
					language,
					printProseTemplate(prose(language, unitId), doc),
				]),
			);
		},
		proseOrSourceMap(unitId, source) {
			return Object.fromEntries(
				effective.languageOrder.map((language) => [
					language,
					unitId === undefined ? source : prose(language, unitId),
				]),
			) as Record<LanguageCode, ProseTemplate>;
		},
	};
}

/** Repeat one language-neutral wire value into every configured locale. */
export function repeatForLanguages(
	languages: readonly LanguageCode[],
	value: string,
): WireLanguageMap {
	return Object.fromEntries(languages.map((language) => [language, value]));
}
