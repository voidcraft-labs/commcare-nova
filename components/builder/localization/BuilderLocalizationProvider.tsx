"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useAppLocalization,
	useLocalizedField as useDocLocalizedField,
	useLocalizedModule as useDocLocalizedModule,
	useLocalizedTranslationUnit as useDocLocalizedTranslationUnit,
	useLocalizedValues as useDocLocalizedValues,
} from "@/lib/doc/hooks/useLocalization";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	type CommitOutcome,
	effectiveAppLocalization,
	type Field,
	type LanguageTag,
	type LocalizedTranslationUnit,
	type LocalizedValue,
	type Module,
	parseLanguageTag,
	resolveAppLanguage,
	type TranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { languageDirection } from "@/lib/domain/languageRegistry";
import {
	pushBuilderHistory,
	useBuilderSearch,
} from "@/lib/routing/useClientPath";

const LANGUAGE_QUERY_KEY = "lang";

export interface BuilderLanguageState {
	readonly language: LanguageTag;
	readonly identity: AppLanguageIdentity;
	readonly sourceLanguage: LanguageTag;
	readonly defaultLanguage: LanguageTag;
	readonly languages: readonly {
		readonly tag: LanguageTag;
		readonly identity: AppLanguageIdentity;
	}[];
	readonly isSource: boolean;
	readonly direction: "ltr" | "rtl";
	selectLanguage(language: LanguageTag): void;
}

const BuilderLocalizationContext = createContext<BuilderLanguageState | null>(
	null,
);

export function BuilderLocalizationProvider({
	children,
}: {
	children: ReactNode;
}) {
	const persisted = useAppLocalization();
	const search = useBuilderSearch();
	const effective = useMemo(
		() => effectiveAppLocalization(persisted),
		[persisted],
	);
	const requested = new URLSearchParams(search).get(LANGUAGE_QUERY_KEY);
	const language = resolveAppLanguage(persisted, requested);
	const selectLanguage = useCallback((next: LanguageTag) => {
		const url = new URL(window.location.href);
		url.searchParams.set(LANGUAGE_QUERY_KEY, next);
		pushBuilderHistory(`${url.pathname}${url.search}`);
	}, []);
	const value = useMemo<BuilderLanguageState>(() => {
		const identity = parseLanguageTag(language);
		return {
			language,
			identity,
			sourceLanguage: effective.sourceLanguage,
			defaultLanguage: effective.defaultLanguage,
			languages: effective.languageOrder.map((tag) => ({
				tag,
				identity: parseLanguageTag(tag),
			})),
			isSource: language === effective.sourceLanguage,
			direction: languageDirection(identity),
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

export function useLocalizedTranslationUnit(
	unitId: TranslationUnitId,
): LocalizedTranslationUnit | undefined {
	return useDocLocalizedTranslationUnit(useBuilderLanguage().language, unitId);
}

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

export function useLocalizedValues(): ReadonlyMap<
	TranslationUnitId,
	LocalizedValue
> {
	return useDocLocalizedValues(useBuilderLanguage().language);
}

export function useLocalizedModule(uuid: Uuid | undefined): Module | undefined {
	return useDocLocalizedModule(useBuilderLanguage().language, uuid);
}

export function useLocalizedField(uuid: Uuid): Field | undefined {
	return useDocLocalizedField(useBuilderLanguage().language, uuid);
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
