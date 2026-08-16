"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import {
	useBlueprintDoc,
	useBlueprintDocEq,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguage,
	type CommitOutcome,
	collectLocalizedTranslationUnits,
	effectiveAppLocalization,
	type Field,
	type LanguageCode,
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
import {
	pushBuilderHistory,
	useBuilderSearch,
} from "@/lib/routing/useClientPath";

const LANGUAGE_QUERY_KEY = "lang";

export interface BuilderLanguageState {
	readonly language: LanguageCode;
	readonly sourceLanguage: LanguageCode;
	readonly defaultLanguage: LanguageCode;
	readonly languages: readonly AppLanguage[];
	readonly isSource: boolean;
	readonly direction: AppLanguage["direction"];
	selectLanguage(language: LanguageCode): void;
}

const BuilderLocalizationContext = createContext<BuilderLanguageState | null>(
	null,
);

export function BuilderLocalizationProvider({
	children,
}: {
	children: ReactNode;
}) {
	const persisted = useBlueprintDoc((doc) => doc.localization);
	const search = useBuilderSearch();
	const effective = useMemo(
		() => effectiveAppLocalization(persisted),
		[persisted],
	);
	const requested = new URLSearchParams(search).get(LANGUAGE_QUERY_KEY);
	const language = resolveAppLanguage(persisted, requested);
	const selectLanguage = useCallback((next: LanguageCode) => {
		const url = new URL(window.location.href);
		url.searchParams.set(LANGUAGE_QUERY_KEY, next);
		pushBuilderHistory(`${url.pathname}${url.search}`);
	}, []);
	const value = useMemo<BuilderLanguageState>(() => {
		const metadata = effective.languages[language];
		return {
			language,
			sourceLanguage: effective.sourceLanguage,
			defaultLanguage: effective.defaultLanguage,
			languages: effective.languageOrder.map(
				(code) => effective.languages[code],
			),
			isSource: language === effective.sourceLanguage,
			direction: metadata.direction,
			selectLanguage,
		};
	}, [effective, language, selectLanguage]);

	return (
		<BlueprintAuthoringLanguageContext value={language}>
			<BuilderLocalizationContext value={value}>
				{children}
			</BuilderLocalizationContext>
		</BlueprintAuthoringLanguageContext>
	);
}

export function useBuilderLanguage(): BuilderLanguageState {
	const value = useContext(BuilderLocalizationContext);
	if (value === null) {
		throw new Error(
			"useBuilderLanguage must be used within BuilderLocalizationProvider",
		);
	}
	return value;
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
	unitId: TranslationUnitId,
): LocalizedTranslationUnit | undefined {
	const { language } = useBuilderLanguage();
	return useBlueprintDocEq((doc) => {
		const unit = translationUnitsById(doc).get(unitId);
		return unit === undefined
			? undefined
			: localizeTranslationUnit(
					doc,
					resolveAppLanguage(doc.localization, language),
					unit,
				);
	}, sameLocalizedUnit);
}

/** Resolve one semantic worker-facing slot through the selected Builder lens. */
export function useLocalizedValue(
	unitId: TranslationUnitId,
): LocalizedValue | undefined {
	return useLocalizedTranslationUnit(unitId)?.effective;
}

export function useLocalizedText(
	unitId: TranslationUnitId,
): string | undefined {
	const value = useLocalizedValue(unitId);
	return typeof value === "string" ? value : undefined;
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
export function useLocalizedValues(): ReadonlyMap<
	TranslationUnitId,
	LocalizedValue
> {
	const { language } = useBuilderLanguage();
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
export function useLocalizedModule(uuid: Uuid | undefined): Module | undefined {
	const { language } = useBuilderLanguage();
	return useBlueprintDocEq(
		(doc) =>
			uuid === undefined
				? undefined
				: projectLocalizedModule(
						doc,
						resolveAppLanguage(doc.localization, language),
						uuid,
					),
		sameModule,
	);
}

/**
 * Project a field through the central translation inventory. Identity, logic,
 * media, values, and references stay untouched; only worker-facing prose and
 * inline option labels can differ from the canonical entity.
 */
export function useLocalizedField(uuid: Uuid): Field | undefined {
	const { language } = useBuilderLanguage();
	return useBlueprintDocEq(
		(doc) =>
			projectLocalizedField(
				doc,
				resolveAppLanguage(doc.localization, language),
				uuid,
			),
		sameField,
	);
}

export interface TranslationUnitEditor {
	readonly unit: LocalizedTranslationUnit | undefined;
	readonly isSource: boolean;
	saveTarget(value: LocalizedValue): CommitOutcome;
}

export function useTranslationUnitEditor(
	unitId: TranslationUnitId,
): TranslationUnitEditor {
	const { language, sourceLanguage, isSource } = useBuilderLanguage();
	const unit = useLocalizedTranslationUnit(unitId);
	const { inline } = useBlueprintMutations();
	const saveTarget = useCallback(
		(value: LocalizedValue): CommitOutcome => {
			if (isSource || unit === undefined) {
				return { ok: false, messages: ["This is the source language."] };
			}
			const mutation: Mutation = {
				kind: "setTranslation",
				language,
				unitId,
				entry: {
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: sourceLanguage,
				},
			};
			return inline.commitMany([mutation]);
		},
		[inline, isSource, language, sourceLanguage, unit, unitId],
	);
	return { unit, isSource, saveTarget };
}
