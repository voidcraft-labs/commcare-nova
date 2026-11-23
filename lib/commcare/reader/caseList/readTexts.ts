/**
 * The document a list's or a search's settle projects: the bound document
 * with the text the reading gave the translation sink in each other language,
 * so a header, a mapping label or a Search field's label projects in every
 * language as the source holds it. The sink's entries reach the reading's
 * document itself only at the assembly; the settles compare before it.
 */
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	isEnglishOnlyLocalization,
	type LanguageTag,
	type TranslationEntry,
	type TranslationUnitId,
} from "@/lib/domain";
import {
	editableLanguageEntries,
	languageEntries,
} from "@/lib/domain/localization";
import {
	authoredTranslationValueMode,
	defaultWording,
	hasGeneratedWording,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { wordingSourceUnit } from "../../generatedSearchWording";
import { withCandidate } from "../candidate";
import { sameJson } from "../jsonCursor";
import { type TranslationSink, translationEntryFor } from "../translations";

/** `doc` with every unit the sink holds written as a translation entry, in each language other
 *  than the source that holds one, against the unit's current source. */
export function withReadTexts(
	doc: BlueprintDoc,
	sink: TranslationSink,
): BlueprintDoc {
	const given = sink.units();
	if (!given.length) return doc;
	const inventory = snapshotTranslationUnits(doc);
	const generated = given.filter(
		(entry) => inventory.get(entry.unit)?.generated !== undefined,
	);
	if (!generated.length) return writeReadTexts(doc, given);
	const withBase = writeReadTexts(
		doc,
		given.filter((entry) => !inventory.get(entry.unit)?.generated),
	);
	return writeReadTexts(withBase, generated);
}

function writeReadTexts(
	doc: BlueprintDoc,
	given: ReturnType<TranslationSink["units"]>,
): BlueprintDoc {
	const localization = effectiveAppLocalization(doc.localization);
	if (given.length === 0) return doc;
	const units = snapshotTranslationUnits(doc);
	const source = localization.sourceLanguage;
	/* Only the entries that change the document are written. A read that
	 * changes nothing hands back `doc` itself, so each list's projection over
	 * it reuses the document's one translation inventory rather than building
	 * it again for a copy. */
	const writes: {
		readonly unit: TranslationUnitId;
		readonly language: LanguageTag;
		readonly entry: TranslationEntry | undefined;
	}[] = [];
	for (const { unit, byLanguage } of given) {
		const raw = units.get(unit);
		const current = raw && wordingSourceUnit(doc, raw);
		if (current === undefined) continue;
		for (const [language, value] of byLanguage) {
			if (language === source && !hasGeneratedWording(current)) continue;
			const read = translationEntryFor(
				current.valueKind,
				current.generated
					? defaultWording(doc, language, current)
					: current.source,
				value,
				source,
			);
			const entry = read && {
				...read,
				...authoredTranslationValueMode(current, read.value),
				sourceFingerprint: current.sourceFingerprint,
			};
			const held = languageEntries(localization, language);
			const unchanged =
				entry === undefined
					? held?.[unit] === undefined
					: held === undefined
						? language !== source
						: sameJson(held[unit], entry);
			if (!unchanged) writes.push({ unit, language, entry });
		}
	}
	if (writes.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		draft.localization ??= {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng"],
			wireCodes: { eng: "en" },
			translations: {},
		};
		const loc = draft.localization;
		for (const { unit, language, entry } of writes) {
			const targets = editableLanguageEntries(
				loc,
				language,
				entry !== undefined,
			);
			if (!targets) continue;
			if (entry === undefined) delete targets[unit];
			else targets[unit] = entry;
		}
		if (!Object.keys(loc.generatedSourceWording ?? {}).length)
			delete loc.generatedSourceWording;
		if (isEnglishOnlyLocalization(loc)) delete draft.localization;
	});
}
