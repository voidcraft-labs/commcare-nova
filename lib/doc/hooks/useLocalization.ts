"use client";

import {
	collectLocalizedTranslationUnits,
	effectiveAppLocalization,
	type Field,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	localizeTranslationUnit,
	type Module,
	projectLocalizedField,
	projectLocalizedModule,
	resolveAppLanguage,
	type TranslationUnitId,
	translationUnitsById,
	type Uuid,
} from "@/lib/domain";
import { useBlueprintDoc, useBlueprintDocEq } from "./useBlueprintDoc";

/** Persisted language configuration, independently of the selected URL lens. */
export function useAppLocalization() {
	return useBlueprintDoc((doc) => doc.localization);
}

/* Zustand publishes immutable document snapshots. Field rows and form/module
 * chrome ask for separate localized projections of the same snapshot, so
 * share its app-wide translation inventory instead of rebuilding it once per
 * selector. The WeakMap naturally discards every superseded snapshot. */
const builderTranslationUnitsByDoc = new WeakMap<
	Parameters<typeof translationUnitsById>[0],
	ReturnType<typeof translationUnitsById>
>();

function builderTranslationUnits(
	doc: Parameters<typeof translationUnitsById>[0],
): ReturnType<typeof translationUnitsById> {
	const cached = builderTranslationUnitsByDoc.get(doc);
	if (cached !== undefined) return cached;
	const units = translationUnitsById(doc);
	builderTranslationUnitsByDoc.set(doc, units);
	return units;
}

function builderTranslationUnitsForProjection(
	doc: Parameters<typeof translationUnitsById>[0],
	language: LanguageTag,
): ReturnType<typeof translationUnitsById> | undefined {
	return language === effectiveAppLocalization(doc.localization).sourceLanguage
		? undefined
		: builderTranslationUnits(doc);
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
		JSON.stringify(left.effective) === JSON.stringify(right.effective) &&
		JSON.stringify(left.explicit) === JSON.stringify(right.explicit)
	);
}

export function useLocalizedTranslationUnit(
	language: LanguageTag,
	unitId: TranslationUnitId,
): LocalizedTranslationUnit | undefined {
	return useBlueprintDocEq((doc) => {
		const unit = builderTranslationUnits(doc).get(unitId);
		return unit === undefined
			? undefined
			: localizeTranslationUnit(
					doc,
					resolveAppLanguage(doc.localization, language),
					unit,
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
		return new Map(
			collectLocalizedTranslationUnits(doc, snapshotLanguage).map((unit) => [
				unit.id,
				unit.effective,
			]),
		);
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
			: projectLocalizedModule(
					doc,
					snapshotLanguage,
					uuid,
					builderTranslationUnitsForProjection(doc, snapshotLanguage),
				);
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
		return projectLocalizedField(
			doc,
			snapshotLanguage,
			uuid,
			builderTranslationUnitsForProjection(doc, snapshotLanguage),
		);
	}, sameField);
}
