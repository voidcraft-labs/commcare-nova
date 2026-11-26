"use client";

import {
	type Field,
	formSubmitWording,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	localizeTranslationUnit,
	type Module,
	projectLocalizedField,
	projectLocalizedModule,
	resolveAppLanguage,
	snapshotTranslationUnits,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import {
	presentedSearchWording,
	workerLocalizedValues,
	workerWording,
} from "../localizationWorkspace";
import { useBlueprintDoc, useBlueprintDocEq } from "./useBlueprintDoc";

/** Persisted language configuration, independently of the selected URL lens. */
export function useAppLocalization() {
	return useBlueprintDoc((doc) => doc.localization);
}

function sameLocalizedUnit(
	left: LocalizedTranslationUnit | undefined,
	right: LocalizedTranslationUnit | undefined,
): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	return (
		left.language === right.language &&
		left.sourceFingerprint === right.sourceFingerprint &&
		left.status === right.status &&
		left.filledFrom === right.filledFrom &&
		JSON.stringify(left.defaultText) === JSON.stringify(right.defaultText) &&
		JSON.stringify(left.effective) === JSON.stringify(right.effective) &&
		JSON.stringify(left.explicit) === JSON.stringify(right.explicit)
	);
}

export function useLocalizedTranslationUnit(
	language: LanguageTag,
	unitId: TranslationUnitId,
): LocalizedTranslationUnit | undefined {
	return useBlueprintDocEq((doc) => {
		const unit = snapshotTranslationUnits(doc).get(unitId);
		return unit === undefined
			? undefined
			: presentedSearchWording(
					doc,
					localizeTranslationUnit(
						doc,
						resolveAppLanguage(doc.localization, language),
						unit,
					),
				);
	}, sameLocalizedUnit);
}

function sameLocalizedValues(
	left: ReadonlyMap<TranslationUnitId, LocalizedValue>,
	right: ReadonlyMap<TranslationUnitId, LocalizedValue>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [id, value] of left) {
		if (JSON.stringify(value) !== JSON.stringify(right.get(id))) return false;
	}
	return true;
}

/** One complete selected-language projection for list and tree renderers. */
export function useLocalizedValues(
	language: LanguageTag,
): ReadonlyMap<TranslationUnitId, LocalizedValue> {
	return useBlueprintDocEq((doc) => {
		const snapshotLanguage = resolveAppLanguage(doc.localization, language);
		return workerLocalizedValues(doc, snapshotLanguage);
	}, sameLocalizedValues);
}

function sameField(left: Field | undefined, right: Field | undefined): boolean {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sameModule(
	left: Module | undefined,
	right: Module | undefined,
): boolean {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Selected-language module chrome, case-list labels, and Search copy. */
export function useLocalizedModule(
	language: LanguageTag,
	uuid: Uuid | undefined,
): Module | undefined {
	return useBlueprintDocEq((doc) => {
		const snapshotLanguage = resolveAppLanguage(doc.localization, language);
		return uuid === undefined
			? undefined
			: projectLocalizedModule(doc, snapshotLanguage, uuid);
	}, sameModule);
}

/**
 * Project a field through the central translation inventory. Identity, logic,
 * media, values, and references stay untouched; only worker-facing prose and
 * inline option labels can differ from the canonical entity.
 */
export function useLocalizedField(
	language: LanguageTag,
	uuid: Uuid,
): Field | undefined {
	return useBlueprintDocEq((doc) => {
		const snapshotLanguage = resolveAppLanguage(doc.localization, language);
		return projectLocalizedField(doc, snapshotLanguage, uuid);
	}, sameField);
}

/**
 * The field as a worker reads it in a language: each label, hint, help text,
 * validation message and option label takes the form builder's fill for a
 * blank value (`lib/domain/translationFill.ts`), in the source language too.
 * Render its text; edit the stored value `useLocalizedField` returns.
 */
export function useFilledField(
	language: LanguageTag,
	uuid: Uuid,
): Field | undefined {
	return useBlueprintDocEq((doc) => {
		const snapshotLanguage = resolveAppLanguage(doc.localization, language);
		return projectLocalizedField(doc, snapshotLanguage, uuid, undefined, {
			filled: true,
		});
	}, sameField);
}

/** The Web Apps action after the worker locale falls back to its built default. */
export function useFormSubmitWording(
	uuid: Uuid | null | undefined,
	language: LanguageTag,
) {
	return useBlueprintDoc((doc) =>
		uuid == null ? undefined : formSubmitWording(doc, uuid, language),
	);
}

/** Every independently worded output of this control. */
export function useControlWordingIds(owner: string) {
	return useBlueprintDocEq(
		(doc) =>
			[...snapshotTranslationUnits(doc).values()]
				.filter((unit) => {
					if (!unit.generated || unit.generated.dormant) return false;
					const place = unit.owner;
					switch (place.kind) {
						case "app":
							return owner === "app";
						case "form":
							return owner === place.formUuid;
						case "module":
							return owner === place.moduleUuid;
						case "search-input":
							return owner === place.searchInputUuid;
						case "case-list-column":
							return owner === place.columnUuid;
						default:
							return false;
					}
				})
				.map((unit) => unit.id),
		(a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
	);
}

export function useWorkerWordingOverride(
	language: LanguageTag,
	id: TranslationUnitId,
) {
	return useBlueprintDoc((doc) =>
		workerWording(
			doc,
			resolveAppLanguage(doc.localization, language),
			id,
			true,
		),
	);
}
