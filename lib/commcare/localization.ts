// lib/commcare/localization.ts
//
// Read-only Blueprint localization projection for CommCare wire emitters.
// Domain translation units remain the authority for identity, freshness, and
// fallback. Emitters ask this object for one unit in one/all app languages;
// they never walk the overlay or reinterpret review state themselves. The
// facade computes the language wire plan once and speaks WIRE CODES on its
// entire public surface — Nova's canonical language tags stay behind it.

import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type LanguageTag,
	localizeTranslationUnit,
	type ProseTemplate,
	printProseTemplate,
	type TranslationUnitId,
	translationUnitsById,
} from "@/lib/domain";
import { planLanguageWire } from "./languageWire";

export type WireLanguageMap = Record<string, string>;

export interface CommCareLocalization {
	/** Wire codes in `languageOrder` order. */
	readonly languages: readonly string[];
	readonly defaultLanguage: string;
	/** The device language picker's label row for one wire code. */
	languageName(wireCode: string): string;
	wireText(wireCode: string, unitId: TranslationUnitId): string;
	text(wireCode: string, unitId: TranslationUnitId): string;
	prose(wireCode: string, unitId: TranslationUnitId): ProseTemplate;
	textMap(unitId: TranslationUnitId): WireLanguageMap;
	proseTextMap(unitId: TranslationUnitId): WireLanguageMap;
	proseOrSourceMap(
		unitId: TranslationUnitId | undefined,
		source: ProseTemplate,
	): Readonly<Record<string, ProseTemplate>>;
}

/**
 * Build one immutable lookup facade for an emission run. Missing and stale
 * entries intentionally resolve through `localizeTranslationUnit` to the
 * canonical source, which is Nova's authored fallback contract.
 */
export function commCareLocalization(doc: BlueprintDoc): CommCareLocalization {
	const effective = effectiveAppLocalization(doc.localization);
	const plan = planLanguageWire(
		effective.languageOrder,
		effective.defaultLanguage,
	);
	const tagByWireCode = new Map<string, LanguageTag>(
		[...plan.wireCodeByTag].map(([tag, code]) => [code, tag]),
	);
	const tagFor = (wireCode: string): LanguageTag => {
		const tag = tagByWireCode.get(wireCode);
		if (tag === undefined) {
			throw new Error(
				`CommCare localization was asked about wire code ${wireCode}, which the language wire plan did not assign. Read codes from this facade's own languages list.`,
			);
		}
		return tag;
	};

	const units = translationUnitsById(doc);
	const requireUnit = (unitId: TranslationUnitId) => {
		const unit = units.get(unitId);
		if (unit === undefined) {
			throw new Error(
				`CommCare localization references unknown unit ${unitId}.`,
			);
		}
		return unit;
	};
	const value = (wireCode: string, unitId: TranslationUnitId) =>
		localizeTranslationUnit(doc, tagFor(wireCode), requireUnit(unitId))
			.effective;

	const text = (wireCode: string, unitId: TranslationUnitId): string => {
		const localized = value(wireCode, unitId);
		if (typeof localized !== "string") {
			throw new Error(`CommCare localization expected text for ${unitId}.`);
		}
		return localized;
	};
	const prose = (
		wireCode: string,
		unitId: TranslationUnitId,
	): ProseTemplate => {
		const localized = value(wireCode, unitId);
		if (typeof localized === "string") {
			throw new Error(`CommCare localization expected prose for ${unitId}.`);
		}
		return localized;
	};
	const wireText = (wireCode: string, unitId: TranslationUnitId): string => {
		const localized = value(wireCode, unitId);
		return typeof localized === "string"
			? localized
			: printProseTemplate(localized, doc);
	};

	return {
		languages: plan.languages,
		defaultLanguage: plan.defaultLanguage,
		languageName(wireCode) {
			const name = plan.nameByWireCode.get(wireCode);
			if (name === undefined) {
				throw new Error(
					`CommCare localization has no picker label for wire code ${wireCode}. Read codes from this facade's own languages list.`,
				);
			}
			return name;
		},
		wireText,
		text,
		prose,
		textMap(unitId) {
			return Object.fromEntries(
				plan.languages.map((wireCode) => [wireCode, text(wireCode, unitId)]),
			);
		},
		proseTextMap(unitId) {
			return Object.fromEntries(
				plan.languages.map((wireCode) => [
					wireCode,
					printProseTemplate(prose(wireCode, unitId), doc),
				]),
			);
		},
		proseOrSourceMap(unitId, source) {
			return Object.fromEntries(
				plan.languages.map((wireCode) => [
					wireCode,
					unitId === undefined ? source : prose(wireCode, unitId),
				]),
			);
		},
	};
}

/** Repeat one language-neutral wire value into every configured locale. */
export function repeatForLanguages(
	wireCodes: readonly string[],
	value: string,
): WireLanguageMap {
	return Object.fromEntries(wireCodes.map((wireCode) => [wireCode, value]));
}
