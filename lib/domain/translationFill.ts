// lib/domain/translationFill.ts
//
// The fill CommCare HQ's form builder applies to a form's itext on every save
// (Vellum `javaRosa/itext.js::ItextForm.getValueOrDefault`), applied by Nova
// to what a worker sees so a save in the form builder changes nothing. Per
// text: a blank value takes the default language's text (the app's first
// language); where that is blank too, the first non-blank value in language
// order; a text blank in every language stays blank. The rule is Vellum's,
// not "the source language's text": the form builder knows nothing of Nova's
// source language. Stored translations are never touched; the fill is derived.

import type { BlueprintDoc } from "./blueprint";
import {
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedValue,
} from "./localization";
import { type ProseTemplate, proseTemplateIsEmpty } from "./prose";
import {
	storedTranslationValue,
	type TranslationUnit,
	type TranslationUnitRole,
} from "./translationUnits";

/** The roles a form's itext carries, each filled on a form-builder save. */
export const TRANSLATION_FILL_ROLES: ReadonlySet<TranslationUnitRole> = new Set(
	[
		"field-label",
		"field-hint",
		"field-help",
		"field-validation-message",
		"select-option-label",
	],
);

/** A prose value with no parts; a whitespace-only run is a real value. */
function isBlank(value: LocalizedValue): boolean {
	return typeof value !== "string" && proseTemplateIsEmpty(value);
}

/**
 * The language whose text a worker reads in `language` for an itext unit
 * whose own value there is blank, or `undefined` when the unit is not filled
 * there: its role is not an itext role, its value is not blank, or it is
 * blank in every language.
 */
export function translationFillSource(
	doc: BlueprintDoc,
	unit: TranslationUnit,
	language: LanguageTag,
): LanguageTag | undefined {
	if (!TRANSLATION_FILL_ROLES.has(unit.role)) return undefined;
	if (!isBlank(storedTranslationValue(doc, language, unit))) return undefined;
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	return languageOrder.find(
		(candidate) => !isBlank(storedTranslationValue(doc, candidate, unit)),
	);
}

/**
 * The text a worker reads for an itext unit in `language`: its stored value
 * there, or, where that is blank, the filled value `translationFillSource`
 * names. A unit of any other role reads its stored value.
 */
export function filledProse(
	doc: BlueprintDoc,
	unit: TranslationUnit,
	language: LanguageTag,
): ProseTemplate {
	const from = translationFillSource(doc, unit, language) ?? language;
	const value = storedTranslationValue(doc, from, unit);
	if (typeof value === "string") {
		throw new Error(
			`Translation unit ${unit.id} holds text, and only a prose unit is filled. Read a text unit's value through localizeTranslationUnit.`,
		);
	}
	return value;
}
