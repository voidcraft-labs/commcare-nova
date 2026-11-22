"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { useAppSettings } from "@/lib/doc/hooks/useAppSettings";
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
	pushBuilderLensHistory,
	useBuilderSearch,
} from "@/lib/routing/useClientPath";
import { usePreviewing } from "@/lib/session/hooks";

const LANGUAGE_QUERY_KEY = "lang";

export interface BuilderLanguageState {
	readonly language: LanguageTag;
	readonly identity: AppLanguageIdentity;
	readonly profiles: readonly { uuid: Uuid; name: string }[];
	readonly profileUuid?: Uuid;
	selectProfile(uuid: string): void;
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
	const previewing = usePreviewing();
	const settings = useAppSettings();
	const search = useBuilderSearch();
	const effective = useMemo(
		() => effectiveAppLocalization(persisted),
		[persisted],
	);
	const query = new URLSearchParams(search);
	const requested = query.get(LANGUAGE_QUERY_KEY);
	const profiles = useMemo(
		() =>
			previewing ? Object.values(settings.installationProfiles ?? {}) : [],
		[previewing, settings.installationProfiles],
	);
	const profile = profiles.find(
		(entry) => entry.uuid === query.get("installation"),
	);
	const order = profile?.languages ?? effective.languageOrder;
	const language = profile
		? requested && order.includes(requested)
			? requested
			: order[0]
		: resolveAppLanguage(persisted, requested);
	const selectProfile = useCallback((uuid: string) => {
		const url = new URL(window.location.href);
		if (uuid) url.searchParams.set("installation", uuid);
		else url.searchParams.delete("installation");
		url.searchParams.delete(LANGUAGE_QUERY_KEY);
		pushBuilderLensHistory(`${url.pathname}${url.search}`);
	}, []);
	const selectLanguage = useCallback((next: LanguageTag) => {
		const url = new URL(window.location.href);
		url.searchParams.set(LANGUAGE_QUERY_KEY, next);
		/* A language is a lens on the screen on show, so the new entry keeps
		 * the Preview case list's held form menu the screen shows. */
		pushBuilderLensHistory(`${url.pathname}${url.search}`);
	}, []);
	const value = useMemo<BuilderLanguageState>(() => {
		const identity = parseLanguageTag(language);
		return {
			language,
			identity,
			sourceLanguage: effective.sourceLanguage,
			defaultLanguage: order[0],
			profiles,
			profileUuid: profile?.uuid,
			selectProfile,
			languages: order.map((tag) => ({
				tag,
				identity: parseLanguageTag(tag),
			})),
			isSource: language === effective.sourceLanguage,
			direction: languageDirection(identity),
			selectLanguage,
		};
	}, [
		effective,
		language,
		order,
		profiles,
		profile,
		selectProfile,
		selectLanguage,
	]);

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

/**
 * Whether the builder shows the source language, which owns every setting a
 * text's languages share (a label's Format text, for one). A surface outside
 * the provider has no language lens, so what it shows is the source.
 */
export function useShowsSourceLanguage(): boolean {
	return useContext(BuilderLocalizationContext)?.isSource ?? true;
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
