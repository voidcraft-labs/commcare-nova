/** Pure selected-language projections for Builder and Preview consumers. */

import type { BlueprintDoc } from "./blueprint";
import { caseMappingTextUnit } from "./caseMappingRows";
import type { Field } from "./fields";
import { FIELD_PROSE_SLOTS } from "./labelForms";
import {
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedValue,
	makeTranslationUnitId,
	type TranslationUnitId,
} from "./localization";
import {
	effectiveCaseSearchConfig,
	type Module,
	NO_SEARCH_SCREEN_TITLE,
	SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
	searchScreenTitleText,
} from "./modules";
import { mediaInLanguage } from "./multimedia";
import { navigationFilesInLanguage } from "./navigationMedia";
import { filledProse, translationFillSource } from "./translationFill";
import {
	caseListWordingUnitId,
	localizeTranslationUnit,
	snapshotTranslationUnits,
	type TranslationUnit,
} from "./translationUnits";
import type { Uuid } from "./uuid";

function localizedText(
	units: ReturnType<typeof snapshotTranslationUnits>,
	doc: BlueprintDoc,
	language: LanguageTag,
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
	language: LanguageTag,
): string {
	return localizedText(
		snapshotTranslationUnits(doc),
		doc,
		language,
		makeTranslationUnitId("app", "name"),
		doc.appName,
	);
}

export function projectLocalizedForm(
	doc: BlueprintDoc,
	language: LanguageTag,
	uuid: Uuid,
) {
	const form = doc.forms[uuid];
	if (form === undefined) return undefined;
	if (
		language === effectiveAppLocalization(doc.localization).sourceLanguage &&
		!form.mediaByLanguage
	) {
		return form;
	}
	return {
		...form,
		...navigationFilesInLanguage(
			form,
			language,
			effectiveAppLocalization(doc.localization),
		),
		name: localizedText(
			snapshotTranslationUnits(doc),
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
	language: LanguageTag,
	uuid: Uuid,
	unitIndex?: ReturnType<typeof snapshotTranslationUnits>,
): Module | undefined {
	const module = doc.modules[uuid];
	if (module === undefined) return undefined;
	const app = effectiveAppLocalization(doc.localization);
	const register = module.caseListRegistrationForm;
	if (
		language === app.sourceLanguage &&
		!module.mediaByLanguage &&
		!module.caseListMenuItem?.mediaByLanguage &&
		!(register?.kind === "always" && register.mediaByLanguage)
	) {
		return module;
	}
	const units = unitIndex ?? snapshotTranslationUnits(doc);
	const text = (id: TranslationUnitId, fallback: string): string =>
		localizedText(units, doc, language, id, fallback);
	const localized = structuredClone(module);
	Object.assign(localized, navigationFilesInLanguage(module, language, app));
	if (localized.caseListMenuItem)
		Object.assign(
			localized.caseListMenuItem,
			navigationFilesInLanguage(localized.caseListMenuItem, language, app),
		);
	if (localized.caseListRegistrationForm?.kind === "always")
		Object.assign(
			localized.caseListRegistrationForm,
			navigationFilesInLanguage(
				localized.caseListRegistrationForm,
				language,
				app,
			),
		);
	localized.name = text(
		makeTranslationUnitId("module", module.uuid, "name"),
		module.name,
	);
	if (localized.caseListConfig !== undefined) {
		for (const rule of localized.caseListConfig.calculatedSorts ?? []) {
			if (rule.label)
				rule.label = text(
					makeTranslationUnitId("case-sort", rule.uuid, "label"),
					rule.label,
				);
		}
		const list = localized.caseListConfig;
		if (list.emptyText !== undefined)
			list.emptyText = text(
				caseListWordingUnitId(module.uuid, "empty"),
				list.emptyText,
			);
		if (list.selectButtonText !== undefined)
			list.selectButtonText = text(
				caseListWordingUnitId(module.uuid, "select"),
				list.selectButtonText,
			);
		for (const tab of localized.caseListConfig.detailTabs ?? [])
			tab.title = text(
				makeTranslationUnitId("detail-tab", tab.uuid, "title"),
				tab.title,
			);
		localized.caseListConfig.columns = localized.caseListConfig.columns.map(
			(column) => {
				const next = {
					...column,
					header: text(
						makeTranslationUnitId("column", column.uuid, "header"),
						column.header,
					),
				};
				if (next.sort?.label !== undefined) {
					next.sort = {
						...next.sort,
						label: text(
							makeTranslationUnitId("column", column.uuid, "sort-label"),
							next.sort.label,
						),
					};
				}
				if (next.kind === "image-map") {
					next.mapping = next.mapping.map((item) =>
						item.altText === undefined
							? item
							: {
									...item,
									altText: text(
										caseMappingTextUnit(column.uuid, item, "image-description"),
										item.altText,
									),
								},
					);
				}
				if (next.kind === "id-mapping") {
					next.mapping = next.mapping.map((mapping) => ({
						...mapping,
						label: text(
							caseMappingTextUnit(column.uuid, mapping, "mapping"),
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
			localized.caseListConfig.searchInputs.map((input) => {
				const next = {
					...input,
					label: text(
						makeTranslationUnitId("search-input", input.uuid, "label"),
						input.label !== "" ? input.label : input.name,
					),
				};
				if (next.kind === "hidden") return next;
				if (next.hint !== undefined) {
					next.hint = text(
						makeTranslationUnitId("search-input", input.uuid, "hint"),
						next.hint,
					);
				}
				if (next.required !== undefined && next.required.noMessage !== true) {
					// A requirement without its own message reads the system
					// sentence, localized once for the whole app.
					next.required = {
						...next.required,
						message:
							next.required.message === undefined
								? text(
										makeTranslationUnitId(
											"system",
											"search-required",
											"default",
										),
										SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE,
									)
								: text(
										makeTranslationUnitId(
											"search-input",
											input.uuid,
											"required-message",
										),
										next.required.message,
									),
					};
				}
				if (next.validation?.message !== undefined) {
					next.validation = {
						...next.validation,
						message: text(
							makeTranslationUnitId(
								"search-input",
								input.uuid,
								"validation-message",
							),
							next.validation.message,
						),
					};
				}
				return next;
			});
	}
	const effectiveSearch = effectiveCaseSearchConfig(module);
	if (effectiveSearch !== undefined) {
		const search = structuredClone(effectiveSearch);
		// The title as this language shows it: its own text, or none where it
		// holds the title blank (`translationUnits.ts`, the search-title unit).
		const title = text(
			makeTranslationUnitId("module", module.uuid, "search-title"),
			searchScreenTitleText(effectiveSearch) ?? "",
		);
		search.searchScreenTitle = title === "" ? NO_SEARCH_SCREEN_TITLE : title;
		if (effectiveSearch.searchScreenSubtitle !== undefined) {
			search.searchScreenSubtitle = text(
				makeTranslationUnitId("module", module.uuid, "search-subtitle"),
				effectiveSearch.searchScreenSubtitle,
			);
		}
		localized.caseSearchConfig = search;
	}
	return localized;
}

/**
 * How a field projection reads its itext slots. `filled` gives what a worker
 * sees: each label, hint, help text, validation message and option label
 * takes the form builder's fill for a blank value (`translationFill.ts`), in
 * the source language too. Without it each slot is the stored value, which
 * every editor edits.
 */
export interface LocalizedFieldProjectionOptions {
	readonly filled?: boolean;
}

/** Project prose and inline option labels without changing identity or logic. */
function hasLocalizedMedia(field: Field): boolean {
	return Boolean(
		("label_media" in field && field.label_media?.mediaByLanguage) ||
			("help_media" in field && field.help_media?.mediaByLanguage) ||
			("optionsSource" in field &&
				field.optionsSource.kind === "inline" &&
				field.optionsSource.options.some(
					(option) => option.media?.mediaByLanguage,
				)),
	);
}

export function projectLocalizedField(
	doc: BlueprintDoc,
	language: LanguageTag,
	uuid: Uuid,
	unitIndex?: ReturnType<typeof snapshotTranslationUnits>,
	options: LocalizedFieldProjectionOptions = {},
): Field | undefined {
	const field = doc.fields[uuid];
	if (field === undefined) return undefined;
	const filled = options.filled === true;
	if (
		!filled &&
		!hasLocalizedMedia(field) &&
		language === effectiveAppLocalization(doc.localization).sourceLanguage
	) {
		return field;
	}
	const units = unitIndex ?? snapshotTranslationUnits(doc);
	return projectFieldWithUnits(doc, language, field, units, filled);
}

/** The units of a field's itext slots and inline option labels. */
function fieldItextUnits(
	field: Field,
	units: ReturnType<typeof snapshotTranslationUnits>,
): TranslationUnit[] {
	const ids: TranslationUnitId[] = [];
	const record = field as unknown as Record<string, unknown>;
	for (const slot of FIELD_PROSE_SLOTS) {
		if (record[slot] !== undefined) {
			ids.push(makeTranslationUnitId("field", field.uuid, slot));
		}
	}
	if ("optionsSource" in field && field.optionsSource.kind === "inline") {
		for (const option of field.optionsSource.options) {
			ids.push(
				makeTranslationUnitId("field", field.uuid, "option", option.uuid),
				makeTranslationUnitId(
					"field",
					field.uuid,
					"option_extended_text",
					option.uuid,
				),
			);
		}
	}
	return ids.flatMap((id) => {
		const unit = units.get(id);
		return unit === undefined ? [] : [unit];
	});
}

function projectFieldWithUnits(
	doc: BlueprintDoc,
	language: LanguageTag,
	field: Field,
	units: ReturnType<typeof snapshotTranslationUnits>,
	filled: boolean,
): Field {
	if (
		!hasLocalizedMedia(field) &&
		language === effectiveAppLocalization(doc.localization).sourceLanguage &&
		(!filled ||
			!fieldItextUnits(field, units).some(
				(unit) => translationFillSource(doc, unit, language) !== undefined,
			))
	) {
		// In the source language a slot the fill leaves alone reads the stored
		// value, so a field with no filled slot is the stored field itself.
		return field;
	}
	const read = (unit: TranslationUnit): LocalizedValue =>
		filled
			? filledProse(doc, unit, language)
			: localizeTranslationUnit(doc, language, unit).effective;
	const localized = structuredClone(field) as Field;
	const { defaultLanguage } = effectiveAppLocalization(doc.localization);
	if ("label_media" in localized && localized.label_media)
		localized.label_media = mediaInLanguage(
			localized.label_media,
			language,
			defaultLanguage,
		);
	if ("help_media" in localized && localized.help_media)
		localized.help_media = mediaInLanguage(
			localized.help_media,
			language,
			defaultLanguage,
		);
	if (
		"optionsSource" in localized &&
		localized.optionsSource.kind === "inline"
	) {
		for (const option of localized.optionsSource.options) {
			if (option.media)
				option.media = mediaInLanguage(option.media, language, defaultLanguage);
		}
	}

	const sourceRecord = field as unknown as Record<string, unknown>;
	const record = localized as unknown as Record<string, unknown>;
	for (const slot of FIELD_PROSE_SLOTS) {
		if (sourceRecord[slot] === undefined) continue;
		const unit = units.get(makeTranslationUnitId("field", field.uuid, slot));
		if (unit !== undefined) {
			record[slot] = read(unit);
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
				const extended = units.get(
					makeTranslationUnitId(
						"field",
						field.uuid,
						"option_extended_text",
						option.uuid,
					),
				);
				return {
					...option,
					...(unit && { label: read(unit) as typeof option.label }),
					...(extended && {
						extended_text: read(extended) as typeof option.label,
					}),
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
	language: LanguageTag,
	options: LocalizedFieldProjectionOptions = {},
): Record<string, Field> {
	const filled = options.filled === true;
	if (
		!filled &&
		!Object.values(doc.fields).some(hasLocalizedMedia) &&
		language === effectiveAppLocalization(doc.localization).sourceLanguage
	) {
		return doc.fields;
	}
	const units = snapshotTranslationUnits(doc);
	let changed = false;
	const projected = Object.fromEntries(
		Object.entries(doc.fields).map(([uuid, field]) => {
			const next = projectFieldWithUnits(doc, language, field, units, filled);
			if (next !== field) changed = true;
			return [uuid, next];
		}),
	);
	return changed ? projected : doc.fields;
}
