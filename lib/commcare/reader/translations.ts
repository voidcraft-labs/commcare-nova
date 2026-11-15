/**
 * Where a reading collects the app's text in its other languages. A stage
 * that reads a text gives the sink its value in each app language that holds
 * one; the text stage and the assembly turn each language's value into a
 * translation entry with `translationEntryFor`. The source language's value
 * is the slot's own, so it makes no entry.
 */

import {
	type LanguageTag,
	type LocalizedValue,
	proseTemplateIsEmpty,
	type TranslationEntry,
	type TranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain";
import { sameJson } from "./jsonCursor";

export interface TranslationSink {
	/** One unit's value in each app language that holds one. The source language's value is the
	 *  slot's own and makes no entry. A later call for one unit and language replaces the earlier. */
	set(
		unit: TranslationUnitId,
		kind: "text" | "prose",
		byLanguage: ReadonlyMap<LanguageTag, LocalizedValue>,
	): void;
	/** Every unit given, in the order first given. */
	units(): readonly {
		readonly unit: TranslationUnitId;
		readonly kind: "text" | "prose";
		readonly byLanguage: ReadonlyMap<LanguageTag, LocalizedValue>;
	}[];
}

/** The sink one reading collects into. */
export function translationSink(): TranslationSink {
	const units = new Map<
		TranslationUnitId,
		{ kind: "text" | "prose"; byLanguage: Map<LanguageTag, LocalizedValue> }
	>();
	return {
		set(unit, kind, byLanguage) {
			const known = units.get(unit);
			if (known === undefined) {
				units.set(unit, { kind, byLanguage: new Map(byLanguage) });
				return;
			}
			known.kind = kind;
			for (const [language, value] of byLanguage)
				known.byLanguage.set(language, value);
		},
		units: () =>
			[...units].map(([unit, { kind, byLanguage }]) => ({
				unit,
				kind,
				byLanguage,
			})),
	};
}

/** A value that holds nothing: the empty text, or a template of no parts. A whitespace-only run
 *  is a real value. */
function isBlank(value: LocalizedValue): boolean {
	return typeof value === "string" ? value === "" : proseTemplateIsEmpty(value);
}

/**
 * The entry a language's value makes, or undefined where it makes none: a
 * value absent, deeply equal to the source, or blank where the source is not
 * (a translation left blank in another language reads as none, and the first
 * publish writes the source's text there, as CommCare HQ's form builder does
 * on every save). Any other value is the person's own translation, reviewed.
 */
export function translationEntryFor(
	kind: "text" | "prose",
	source: LocalizedValue,
	target: LocalizedValue | undefined,
	sourceLanguage: LanguageTag,
): TranslationEntry | undefined {
	if (target === undefined) return undefined;
	if (sameJson(source, target)) return undefined;
	if (isBlank(target) && !isBlank(source)) return undefined;
	return {
		value: target,
		sourceFingerprint: translationSourceFingerprint(kind, source),
		origin: "human",
		review: "reviewed",
		translatedFrom: sourceLanguage,
	};
}
