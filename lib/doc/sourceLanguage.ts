import type { Draft } from "immer";
import type {
	AppLocalization,
	BlueprintDoc,
	LanguageTag,
	LocalizedValue,
	TranslationEntry,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import {
	rebaseFormMediaLanguages,
	rebaseNavigationMedia,
} from "@/lib/domain/formMediaLanguages";
import {
	effectiveAppLocalization,
	languageEntries,
	makeTranslationUnitId,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
} from "@/lib/domain/localization";
import { recordFromEntries } from "@/lib/domain/records";
import {
	hasGeneratedWording,
	LABEL_TEXT_SLOT_OF_ROLE,
	snapshotTranslationUnits,
	type TranslationUnit,
	translatedProseValueMode,
	translationIsOutOfDate,
	translationUnitProseSlot,
} from "@/lib/domain/translationUnits";
import { deepEqual } from "./deepEqual";
import {
	effectiveWordingValue,
	wordingSourceUnit,
} from "./localizationWorkspace";

/** `entry` marked as showing its own values exactly when its references
 *  differ from `source`'s, on a question or choice prose unit. */
function withValueModeAgainst(
	unit: TranslationUnit,
	source: LocalizedValue,
	entry: TranslationEntry,
): TranslationEntry {
	const { valueMode: _held, ...rest } = entry;
	const mode =
		translationUnitProseSlot(unit) !== undefined &&
		typeof source !== "string" &&
		typeof entry.value !== "string"
			? translatedProseValueMode(source, entry.value)
			: {};
	if (mode.valueMode === entry.valueMode) return entry;
	return { ...rest, ...mode };
}

import { NO_SEARCH_SCREEN_TITLE } from "@/lib/domain/modules";

type SlotWriter = (draft: Draft<BlueprintDoc>, value: LocalizedValue) => void;

/** Where a unit's source text lives in the document, as a writer of that slot; undefined for a
 *  unit whose source is Nova's own sentence (a system unit), which no document holds. */
export function sourceSlotWriter(
	unit: TranslationUnit,
): SlotWriter | undefined {
	const owner = unit.owner;
	const text = (value: LocalizedValue) => value as string;
	switch (unit.role) {
		case "app-name":
			return (draft, value) => {
				draft.appName = text(value);
			};
		case "menu-badge":
			return owner.kind === "form" || owner.kind === "module"
				? (draft, value) => {
						const badge =
							owner.kind === "form"
								? draft.forms[owner.formUuid]?.badge
								: draft.modules[owner.moduleUuid]?.badge;
						if (badge?.kind === "text") badge.text = text(value);
					}
				: undefined;
		case "module-name":
			return owner.kind === "module"
				? (draft, value) => {
						const module = draft.modules[owner.moduleUuid];
						if (module !== undefined) module.name = text(value);
					}
				: undefined;
		case "case-list-menu-item-label":
			return owner.kind === "module"
				? (draft, value) => {
						const item = draft.modules[owner.moduleUuid]?.caseListMenuItem;
						if (item !== undefined) item.label = text(value);
					}
				: undefined;
		case "case-list-registration-label":
			return owner.kind === "module"
				? (draft, value) => {
						const registration =
							draft.modules[owner.moduleUuid]?.caseListRegistrationForm;
						if (registration !== undefined) registration.label = text(value);
					}
				: undefined;
		case "form-name":
			return owner.kind === "form"
				? (draft, value) => {
						const form = draft.forms[owner.formUuid];
						if (form !== undefined) form.name = text(value);
					}
				: undefined;
		case "field-label":
		case "field-hint":
		case "field-help":
		case "field-validation-message":
		case "field-extended-text":
		case "field-qr-code":
		case "field-spoken-text": {
			const slot = {
				"field-label": "label",
				"field-hint": "hint",
				"field-help": "help",
				"field-validation-message": "validate_msg",
				...LABEL_TEXT_SLOT_OF_ROLE,
			}[unit.role];
			return owner.kind === "field"
				? (draft, value) => {
						const field = draft.fields[owner.fieldUuid] as
							| Record<string, unknown>
							| undefined;
						if (field !== undefined) field[slot] = value;
					}
				: undefined;
		}
		case "select-option-label":
			return owner.kind === "select-option"
				? (draft, value) => {
						const field = draft.fields[owner.fieldUuid];
						if (
							field === undefined ||
							!("optionsSource" in field) ||
							field.optionsSource.kind !== "inline"
						)
							return;
						const option = field.optionsSource.options.find(
							(one) => one.uuid === owner.optionUuid,
						);
						if (option !== undefined)
							option.label = value as typeof option.label;
					}
				: undefined;
		case "case-detail-tab-title":
			return owner.kind === "module"
				? (draft, value) => {
						const tab = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.detailTabs?.find(
							(item) => item.uuid === unit.context.detailTabUuid,
						);
						if (tab) tab.title = text(value);
					}
				: undefined;
		case "case-list-header":
		case "case-list-interval-text":
		case "case-list-calculation-text":
		case "case-list-image-description":
		case "case-list-mapping-label":
			return owner.kind === "case-list-column"
				? (draft, value) => {
						const column = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.columns.find(
							(one) => one.uuid === owner.columnUuid,
						);
						if (column === undefined) return;
						if (unit.role === "case-list-header") column.header = text(value);
						else if (
							unit.role === "case-list-interval-text" &&
							column.kind === "interval"
						)
							column.text = text(value);
						else if (
							unit.role === "case-list-calculation-text" &&
							column.kind === "calculated"
						) {
							const piece = column.texts?.find(
								(one) =>
									makeTranslationUnitId(
										"column",
										column.uuid,
										"calculation-text",
										one.uuid,
									) === unit.id,
							);
							if (piece !== undefined) piece.label = text(value);
						} else if (
							unit.role === "case-list-image-description" &&
							column.kind === "image-map"
						) {
							// A row is its unit's own: by UUID, or by value before row identities.
							const row = column.mapping.find(
								(one) =>
									caseMappingTextUnit(column.uuid, one, "image-description") ===
									unit.id,
							);
							if (row !== undefined) row.altText = text(value);
						} else if (
							unit.role === "case-list-mapping-label" &&
							column.kind === "id-mapping"
						) {
							const row = column.mapping.find(
								(one) =>
									caseMappingTextUnit(column.uuid, one, "mapping") === unit.id,
							);
							if (row !== undefined) row.label = text(value);
						}
					}
				: undefined;
		case "case-list-sort-label":
			return owner.kind === "case-list-column"
				? (draft, value) => {
						const column = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.columns.find(
							(one) => one.uuid === owner.columnUuid,
						);
						if (column?.sort !== undefined) column.sort.label = text(value);
					}
				: owner.kind === "module"
					? (draft, value) => {
							// A named calculation in the list's default order.
							const rule = draft.modules[
								owner.moduleUuid
							]?.caseListConfig?.calculatedSorts?.find(
								(one) =>
									makeTranslationUnitId("case-sort", one.uuid, "label") ===
									unit.id,
							);
							if (rule !== undefined) rule.label = text(value);
						}
					: undefined;
		case "case-list-empty-text":
		case "case-list-select-text":
			return owner.kind === "module"
				? (draft, value) => {
						const list = draft.modules[owner.moduleUuid]?.caseListConfig;
						if (list === undefined) return;
						if (unit.role === "case-list-empty-text")
							list.emptyText = text(value);
						else list.selectButtonText = text(value);
					}
				: undefined;
		case "case-property-option-label":
			return owner.kind === "case-property-option"
				? (draft, value) => {
						const options = draft.caseTypes
							?.find((type) => type.name === owner.caseType)
							?.properties.find((one) => one.name === owner.property)?.options;
						const option = options?.filter((one) => one.value === owner.value)[
							owner.occurrence
						];
						if (option !== undefined)
							option.label = value as typeof option.label;
					}
				: undefined;
		case "search-input-label":
		case "search-input-hint":
		case "search-input-required-message":
		case "search-input-validation-message":
			return owner.kind === "search-input"
				? (draft, value) => {
						const input = draft.modules[
							owner.moduleUuid
						]?.caseListConfig?.searchInputs.find(
							(one) => one.uuid === owner.searchInputUuid,
						);
						if (input === undefined) return;
						if (unit.role === "search-input-label") input.label = text(value);
						else if (input.kind === "hidden") return;
						else if (unit.role === "search-input-hint")
							input.hint = text(value);
						else if (
							unit.role === "search-input-required-message" &&
							input.required !== undefined
						)
							input.required.message = text(value);
						else if (
							unit.role === "search-input-validation-message" &&
							input.validation !== undefined
						)
							input.validation.message = text(value);
					}
				: undefined;
		case "search-screen-title":
		case "search-screen-subtitle":
			return owner.kind === "module"
				? (draft, value) => {
						const module = draft.modules[owner.moduleUuid];
						if (module === undefined) return;
						module.caseSearchConfig = {
							...module.caseSearchConfig,
							...(unit.role === "search-screen-title"
								? {
										searchScreenTitle:
											text(value) === "" ? NO_SEARCH_SCREEN_TITLE : text(value),
									}
								: { searchScreenSubtitle: text(value) }),
						};
					}
				: undefined;
		default:
			return undefined;
	}
}

/** A stale ordinary translation becoming the canonical source has no target map to
 * keep its saved draft. The change review offers that exact phrase for repair. */
export function staleSourceTranslation(
	doc: BlueprintDoc,
	target: LanguageTag,
): TranslationUnit | undefined {
	const entries = doc.localization?.translations[target];
	if (!entries) return undefined;
	const units = snapshotTranslationUnits(doc);
	for (const [id, entry] of Object.entries(entries)) {
		const unit = units.get(id);
		if (
			unit &&
			!hasGeneratedWording(unit) &&
			translationIsOutOfDate(entry, unit)
		)
			return unit;
	}
	return undefined;
}

/** A source change moves ordinary source text into its authored slot. Generated
 * defaults belong to their generator: their language-specific wording travels
 * with the language, including saved drafts, review and worker fallbacks. */
export function rebaseSourceLanguage(
	draft: Draft<BlueprintDoc>,
	doc: BlueprintDoc,
	target: LanguageTag,
	mode: "saved-document" | "reading",
): void {
	const localization = doc.localization;
	if (
		localization === undefined ||
		localization.sourceLanguage === target ||
		!localization.languageOrder.includes(target) ||
		(mode === "saved-document" &&
			staleSourceTranslation(doc, target) !== undefined)
	)
		return;
	const order = localization.languageOrder;
	// The worker's files stay where they are: the new source language takes
	// the shared slot, and every other language keeps the file it showed.
	rebaseNavigationMedia(
		draft,
		effectiveAppLocalization(localization),
		target,
		order,
	);
	rebaseFormMediaLanguages(
		draft.fields,
		target,
		order,
		localization.defaultLanguage,
		localization.defaultLanguage,
	);
	const texts = [...snapshotTranslationUnits(doc).values()].map((raw) => {
		const unit = wordingSourceUnit(doc, raw);
		return {
			unit,
			byLanguage: order.map(
				(language) =>
					[language, effectiveWordingValue(doc, language, unit)] as const,
			),
		};
	});
	const generatedSourceWording = recordFromEntries<TranslationEntry>([]);
	const translations = recordFromEntries(
		order
			.filter((tag) => tag !== target)
			.map((tag) => [tag, recordFromEntries<TranslationEntry>([])]),
	);
	for (const { unit, byLanguage } of texts) {
		if (hasGeneratedWording(unit)) {
			const original = byLanguage.find(
				([language]) => language === target,
			)?.[1];
			if (original === undefined) continue;
			const fingerprint = translationSourceFingerprint(
				unit.valueKind,
				original,
			);
			for (const [language, effective] of byLanguage) {
				const held = languageEntries(localization, language)?.[unit.id];
				if (!held) continue;
				const into =
					language === target ? generatedSourceWording : translations[language];
				const stale = translationIsOutOfDate(
					held,
					unit,
					language,
					language === localization.sourceLanguage,
				);
				if (stale) {
					into[unit.id] = {
						...held,
						workerFallback: {
							value: effective,
							sourceFingerprint: fingerprint,
						},
					};
				} else if (
					language !== target &&
					language !== localization.sourceLanguage &&
					held.origin !== "human" &&
					held.translatedFrom !== language &&
					!translationSourceFingerprintsEqual(
						fingerprint,
						unit.sourceFingerprint,
					)
				) {
					// HQ still serves a valid draft in that language. Changing its
					// original calls for another review, while the worker keeps the wording.
					into[unit.id] = {
						...held,
						sourceFingerprint: fingerprint,
						review: "needs-review",
					};
				} else into[unit.id] = held;
			}
			continue;
		}
		const write = sourceSlotWriter(unit);
		const read = byLanguage.find(([language]) => language === target)?.[1];
		const next = write === undefined || read === undefined ? unit.source : read;
		if (write !== undefined && !deepEqual(next, unit.source))
			write(draft, next);
		const sourceFingerprint = translationSourceFingerprint(
			unit.valueKind,
			next,
		);
		for (const [language, value] of byLanguage) {
			const into = translations[language];
			if (into === undefined) continue;
			const held = localization.translations[language]?.[unit.id];
			if (mode === "saved-document" && held !== undefined) {
				if (translationIsOutOfDate(held, unit)) {
					const { workerFallback: _oldFallback, ...saved } = held;
					// A matching old fingerprint must not silently promote the
					// previously stale wording when a different language becomes source.
					into[unit.id] =
						deepEqual(value, next) &&
						!translationSourceFingerprintsEqual(
							held.sourceFingerprint,
							sourceFingerprint,
						)
							? saved
							: { ...saved, workerFallback: { value, sourceFingerprint } };
					continue;
				}
				if (deepEqual(unit.source, next)) {
					// Copied, reviewed and historical stale entries still refer
					// to exactly the same source text.
					into[unit.id] = held;
					continue;
				}
				if (deepEqual(held.value, value)) {
					into[unit.id] = {
						...held,
						sourceFingerprint,
						review: "needs-review",
					};
					continue;
				}
			}
			if (deepEqual(value, next)) continue;
			into[unit.id] = {
				value,
				sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: target,
			};
		}
		// A language that showed its own values may now be the source, and the
		// former source a translation: each entry is held against the new
		// source's references.
		for (const into of Object.values(translations)) {
			const entry = into[unit.id];
			if (entry !== undefined)
				into[unit.id] = withValueModeAgainst(unit, next, entry);
		}
	}
	if (draft.localization !== undefined) {
		draft.localization.sourceLanguage = target;
		if (Object.keys(generatedSourceWording).length)
			draft.localization.generatedSourceWording =
				generatedSourceWording as Draft<
					AppLocalization["generatedSourceWording"]
				>;
		else delete draft.localization.generatedSourceWording;
		draft.localization.translations = translations as Draft<
			AppLocalization["translations"]
		>;
	}
}
