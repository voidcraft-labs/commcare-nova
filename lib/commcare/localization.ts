// lib/commcare/localization.ts
//
// Read-only Blueprint localization projection for CommCare wire emitters.
// Domain translation units remain the authority for identity, freshness, and
// fallback. Emitters ask this object for one unit in one/all app languages;
// they never walk the overlay or reinterpret review state themselves. The
// facade reads the language wire plan once, from the codes the document
// stores, and speaks WIRE CODES on its entire public surface — Nova's
// canonical language tags stay behind it.

import {
	type BlueprintDoc,
	effectiveAppLocalization,
	filledProse,
	type LanguageTag,
	localizeTranslationUnit,
	type ProseTemplate,
	printProseTemplate,
	snapshotTranslationUnits,
	TRANSLATION_FILL_ROLES,
	type TranslationUnitId,
	type WireStringSource,
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
	/** `wireText` over a source that may join several units with one space. */
	wireTextFor(wireCode: string, source: WireStringSource): string;
	text(wireCode: string, unitId: TranslationUnitId): string;
	/** A prose unit in one language. */
	prose(wireCode: string, unitId: TranslationUnitId): ProseTemplate;
	textMap(unitId: TranslationUnitId): WireLanguageMap;
	/** `textMap` over a source that may join several units with one space. */
	textMapFor(source: WireStringSource): WireLanguageMap;
	proseTextMap(unitId: TranslationUnitId): WireLanguageMap;
	proseOrSourceMap(
		unitId: TranslationUnitId | undefined,
		source: ProseTemplate,
	): Readonly<Record<string, ProseTemplate>>;
}

/**
 * Build one immutable lookup facade for an emission run. Missing and stale
 * entries intentionally resolve through `localizeTranslationUnit` to the
 * canonical source, which is Nova's authored fallback contract. A form's
 * itext (a label, hint, help text, validation message or option label) then
 * takes the fill HQ's form builder applies on every save
 * (`lib/domain/translationFill.ts::filledProse`), so a save changes no value
 * Nova wrote; every method reads one unit the same way.
 */
export function commCareLocalization(doc: BlueprintDoc): CommCareLocalization {
	const effective = effectiveAppLocalization(doc.localization);
	const plan = planLanguageWire(effective);
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

	const units = snapshotTranslationUnits(doc);
	const requireUnit = (unitId: TranslationUnitId) => {
		const unit = units.get(unitId);
		if (unit === undefined) {
			throw new Error(
				`CommCare localization references unknown unit ${unitId}.`,
			);
		}
		return unit;
	};
	// A form's itext unit reads the form builder's fill on every method, so
	// each spelling of one unit in one language agrees.
	const value = (wireCode: string, unitId: TranslationUnitId) => {
		const unit = requireUnit(unitId);
		return TRANSLATION_FILL_ROLES.has(unit.role)
			? filledProse(doc, unit, tagFor(wireCode))
			: localizeTranslationUnit(doc, tagFor(wireCode), unit).effective;
	};

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
	const wireTextFor = (wireCode: string, source: WireStringSource): string =>
		typeof source === "string"
			? wireText(wireCode, source)
			: source.map((unitId) => wireText(wireCode, unitId)).join(" ");
	const textFor = (wireCode: string, source: WireStringSource): string =>
		typeof source === "string"
			? text(wireCode, source)
			: source.map((unitId) => text(wireCode, unitId)).join(" ");

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
		wireTextFor,
		text,
		prose,
		textMap(unitId) {
			return Object.fromEntries(
				plan.languages.map((wireCode) => [wireCode, text(wireCode, unitId)]),
			);
		},
		textMapFor(source) {
			return Object.fromEntries(
				plan.languages.map((wireCode) => [wireCode, textFor(wireCode, source)]),
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
