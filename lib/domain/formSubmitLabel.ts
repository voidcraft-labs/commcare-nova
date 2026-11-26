import type { BlueprintDoc } from "./blueprint";
import {
	effectiveAppLocalization,
	type LanguageTag,
	makeTranslationUnitId,
} from "./localization";
import type { Uuid } from "./uuid";

export const DEFAULT_FORM_SUBMIT_LABEL = "Submit";

/** The form's ordinary action before an app-wide UI translation can override it.
 * A language with no configured value generates Submit. A configured blank
 * leaves its locale key absent and inherits the default file, whose value is
 * the first nonblank action in build-language order, or blank if all are blank. */
export function formSubmitWording(
	doc: BlueprintDoc,
	uuid: Uuid,
	language: LanguageTag,
): string | undefined {
	const label = doc.forms[uuid]?.submitLabel;
	if (label === undefined) return undefined;
	const localization = effectiveAppLocalization(doc.localization);
	const unit = makeTranslationUnitId("form", uuid, "submit-label");
	const ordinary = (tag: LanguageTag) => {
		const raw =
			tag === localization.sourceLanguage
				? label.text
				: localization.translations[tag]?.[unit]?.value;
		return typeof raw === "string" ? raw : DEFAULT_FORM_SUBMIT_LABEL;
	};
	return (
		ordinary(language) ||
		localization.languageOrder.map(ordinary).find((value) => value !== "") ||
		""
	);
}
