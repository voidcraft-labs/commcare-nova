/**
 * The one name a form carries in its own XForm: `<h:title>` and the primary
 * instance's `name` attribute both hold it, and Preview's `/data/@name`
 * reads it.
 */

import type { BlueprintDoc } from "./blueprint";
import {
	effectiveAppLocalization,
	makeTranslationUnitId,
} from "./localization";
import {
	localizeTranslationUnit,
	snapshotTranslationUnits,
} from "./translationUnits";
import type { Uuid } from "./uuid";

/**
 * The form's name in the app's default language, character for character
 * the string HQ JSON's `form.name` holds for that language.
 *
 * HQ's form builder takes HQ's name for the form in the editing language and
 * writes it into both places on every save (`views/formdesigner.py::
 * _get_vellum_core_context`, `'formName'`; Vellum `writer.js::createXForm`),
 * so a form that already carries the default-language name is unchanged by a
 * save made in the default editing language. A missing or stale translation
 * falls back to the source text, as `localizeTranslationUnit` resolves it
 * for every other wire string.
 */
export function formWireName(doc: BlueprintDoc, formUuid: Uuid): string {
	const form = doc.forms[formUuid];
	if (form === undefined) {
		throw new Error(
			`formWireName was asked for form ${formUuid}, which the document does not hold.`,
		);
	}
	const unit = snapshotTranslationUnits(doc).get(
		makeTranslationUnitId("form", formUuid, "name"),
	);
	if (unit === undefined) return form.name;
	const value = localizeTranslationUnit(
		doc,
		effectiveAppLocalization(doc.localization).defaultLanguage,
		unit,
	).effective;
	return typeof value === "string" ? value : form.name;
}
