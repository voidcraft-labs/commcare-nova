/**
 * Rule: a search title blank in a language shows blank there.
 *
 * A search's title is one translation unit, which a language may hold blank:
 * the source language through the search's `none` title, any other through a
 * blank translation. CommCare HQ's build shows a language's own title, and
 * where that is blank the first language's
 * (`app_strings.py::_create_case_search_app_strings` drops a blank one,
 * `non_empty_only`; the `default` table every language falls back to holds
 * the first language's, `create_default_app_strings`,
 * `models/case_search.py::get_search_title_label`). So a language shows no
 * heading only where the first language shows none too: a title blank in
 * another language beside the first language's text would show that text.
 */

import {
	type BlueprintDoc,
	effectiveAppLocalization,
	effectiveCaseSearchConfig,
	type LanguageTag,
	type Module,
	makeTranslationUnitId,
	resolveTranslationUnitValue,
	type Uuid,
} from "@/lib/domain";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { type ValidationError, validationError } from "../../errors";

/** The languages whose search title shows blank on a search whose first language shows text. */
export function searchTitleBlankBesideFirst(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly LanguageTag[] {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || effectiveCaseSearchConfig(mod) === undefined)
		return [];
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	const unit = makeTranslationUnitId("module", moduleUuid, "search-title");
	const blank = (language: LanguageTag) => {
		const value = resolveTranslationUnitValue(doc, language, unit);
		return typeof value === "string" && value.trim() === "";
	};
	const [first] = languageOrder;
	if (first === undefined || blank(first)) return [];
	return languageOrder.filter(blank);
}

export function searchTitleLanguages(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const blank = searchTitleBlankBesideFirst(doc, moduleUuid);
	if (blank.length === 0) return [];
	const { languageOrder } = effectiveAppLocalization(doc.localization);
	const name = (language: LanguageTag) =>
		resolvedLanguageDisplayLabel(language) ?? language;
	const first = name(languageOrder[0] ?? blank[0]);
	const languages = blank.map(name).join(", ");
	const reason = `A language with no title of its own shows the title of the app's first language, so ${languages} would show the ${first} title. Give the title text in ${languages}, or leave it blank in ${first} too.`;
	return [
		validationError(
			"CASE_LIST_SEARCH_TITLE_BLANK_BESIDE_FIRST",
			"module",
			`The search on module "${mod.name}" has no title in ${languages} while ${first}, the app's first language, shows one. ${reason}`,
			{ moduleUuid, moduleName: mod.name },
			{
				slot: "caseSearchConfig.searchScreenTitle",
				languages,
				reason,
			},
		),
	];
}
