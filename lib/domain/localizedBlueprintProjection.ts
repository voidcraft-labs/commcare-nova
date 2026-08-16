/** Pure selected-language projections for Builder and Preview consumers. */

import type { BlueprintDoc } from "./blueprint";
import type { Field } from "./fields";
import {
	effectiveAppLocalization,
	type LanguageCode,
	makeTranslationUnitId,
	type TranslationUnitId,
} from "./localization";
import {
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	type Module,
} from "./modules";
import {
	localizeTranslationUnit,
	translationUnitsById,
} from "./translationUnits";
import type { Uuid } from "./uuid";

function localizedText(
	units: ReturnType<typeof translationUnitsById>,
	doc: BlueprintDoc,
	language: LanguageCode,
	id: TranslationUnitId,
	fallback: string,
): string {
	const unit = units.get(id);
	if (unit === undefined) return fallback;
	const value = localizeTranslationUnit(doc, language, unit).effective;
	return typeof value === "string" ? value : fallback;
}

export function projectLocalizedAppName(
	doc: BlueprintDoc,
	language: LanguageCode,
): string {
	return localizedText(
		translationUnitsById(doc),
		doc,
		language,
		makeTranslationUnitId("app", "name"),
		doc.appName,
	);
}

export function projectLocalizedForm(
	doc: BlueprintDoc,
	language: LanguageCode,
	uuid: Uuid,
) {
	const form = doc.forms[uuid];
	if (form === undefined) return undefined;
	if (language === effectiveAppLocalization(doc.localization).sourceLanguage) {
		return form;
	}
	return {
		...form,
		name: localizedText(
			translationUnitsById(doc),
			doc,
			language,
			makeTranslationUnitId("form", uuid, "name"),
			form.name,
		),
	};
}

/** Project module chrome, case-list labels, and Search copy only. */
export function projectLocalizedModule(
	doc: BlueprintDoc,
	language: LanguageCode,
	uuid: Uuid,
): Module | undefined {
	const module = doc.modules[uuid];
	if (module === undefined) return undefined;
	if (language === effectiveAppLocalization(doc.localization).sourceLanguage) {
		return module;
	}
	const units = translationUnitsById(doc);
	const text = (id: TranslationUnitId, fallback: string): string =>
		localizedText(units, doc, language, id, fallback);
	const localized = structuredClone(module);
	localized.name = text(
		makeTranslationUnitId("module", module.uuid, "name"),
		module.name,
	);
	if (localized.caseListConfig !== undefined) {
		localized.caseListConfig.columns = localized.caseListConfig.columns.map(
			(column) => {
				const next = {
					...column,
					header: text(
						makeTranslationUnitId("column", column.uuid, "header"),
						column.header,
					),
				};
				if (next.kind === "id-mapping") {
					next.mapping = next.mapping.map((mapping) => ({
						...mapping,
						label: text(
							makeTranslationUnitId(
								"column",
								column.uuid,
								"mapping",
								mapping.value,
							),
							mapping.label,
						),
					}));
				}
				if (next.kind === "interval") {
					next.text = text(
						makeTranslationUnitId("column", column.uuid, "text"),
						next.text,
					);
				}
				return next;
			},
		);
		localized.caseListConfig.searchInputs =
			localized.caseListConfig.searchInputs.map((input) => ({
				...input,
				label: text(
					makeTranslationUnitId("search-input", input.uuid, "label"),
					input.label !== "" ? input.label : input.name,
				),
			}));
	}
	const effectiveSearch = effectiveCaseSearchConfig(module);
	if (effectiveSearch !== undefined) {
		const search = structuredClone(effectiveSearch);
		search.searchScreenTitle = text(
			makeTranslationUnitId("module", module.uuid, "search-title"),
			effectiveSearch.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE,
		);
		if (effectiveSearch.searchScreenSubtitle !== undefined) {
			search.searchScreenSubtitle = text(
				makeTranslationUnitId("module", module.uuid, "search-subtitle"),
				effectiveSearch.searchScreenSubtitle,
			);
		}
		search.searchButtonLabel = text(
			makeTranslationUnitId("module", module.uuid, "search-button"),
			effectiveSearch.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL,
		);
		localized.caseSearchConfig = search;
	}
	return localized;
}

/** Project prose and inline option labels without changing identity or logic. */
export function projectLocalizedField(
	doc: BlueprintDoc,
	language: LanguageCode,
	uuid: Uuid,
): Field | undefined {
	const field = doc.fields[uuid];
	if (field === undefined) return undefined;
	if (language === effectiveAppLocalization(doc.localization).sourceLanguage) {
		return field;
	}
	const units = translationUnitsById(doc);
	return projectFieldWithUnits(doc, language, field, units);
}

function projectFieldWithUnits(
	doc: BlueprintDoc,
	language: LanguageCode,
	field: Field,
	units: ReturnType<typeof translationUnitsById>,
): Field {
	const localized = structuredClone(field) as Field;
	const sourceRecord = field as unknown as Record<string, unknown>;
	const record = localized as unknown as Record<string, unknown>;
	for (const slot of ["label", "hint", "help", "validate_msg"] as const) {
		if (sourceRecord[slot] === undefined) continue;
		const unit = units.get(makeTranslationUnitId("field", field.uuid, slot));
		if (unit !== undefined) {
			record[slot] = localizeTranslationUnit(doc, language, unit).effective;
		}
	}
	if (
		"optionsSource" in localized &&
		localized.optionsSource.kind === "inline"
	) {
		localized.optionsSource.options = localized.optionsSource.options.map(
			(option) => {
				const unit = units.get(
					makeTranslationUnitId("field", field.uuid, "option", option.uuid),
				);
				if (unit === undefined) return option;
				return {
					...option,
					label: localizeTranslationUnit(doc, language, unit)
						.effective as typeof option.label,
				};
			},
		);
	}
	return localized;
}

/**
 * Project the complete field map while building the translation-unit index
 * once. The Preview engine consumes the whole map, so calling the single-field
 * projector for every field would rebuild the same document inventory N times.
 */
export function projectLocalizedFields(
	doc: BlueprintDoc,
	language: LanguageCode,
): Record<string, Field> {
	if (language === effectiveAppLocalization(doc.localization).sourceLanguage) {
		return doc.fields;
	}
	const units = translationUnitsById(doc);
	return Object.fromEntries(
		Object.entries(doc.fields).map(([uuid, field]) => [
			uuid,
			projectFieldWithUnits(doc, language, field, units),
		]),
	);
}
