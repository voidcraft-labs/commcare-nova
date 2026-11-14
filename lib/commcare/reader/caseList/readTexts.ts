/**
 * The document a list's or a search's settle projects: the bound document
 * with the text the reading gave the translation sink in each other language,
 * so a header, a mapping label or a Search field's label projects in every
 * language as the source holds it. The sink's entries reach the reading's
 * document itself only at the assembly; the settles compare before it.
 */
import type { BlueprintDoc } from "@/lib/domain";
import { snapshotTranslationUnits } from "@/lib/domain/translationUnits";
import { withCandidate } from "../candidate";
import { type TranslationSink, translationEntryFor } from "../translations";

/** `doc` with every unit the sink holds written as a translation entry, in each language other
 *  than the source that holds one, against the unit's current source. */
export function withReadTexts(
	doc: BlueprintDoc,
	sink: TranslationSink,
): BlueprintDoc {
	const localization = doc.localization;
	const given = sink.units();
	if (localization === undefined || given.length === 0) return doc;
	const units = snapshotTranslationUnits(doc);
	const source = localization.sourceLanguage;
	return withCandidate(doc, (draft) => {
		const translations = draft.localization?.translations;
		if (translations === undefined) return;
		for (const { unit, byLanguage } of given) {
			const current = units.get(unit);
			if (current === undefined) continue;
			for (const [language, value] of byLanguage) {
				if (language === source) continue;
				const targets = translations[language];
				if (targets === undefined) continue;
				const entry = translationEntryFor(
					current.valueKind,
					current.source,
					value,
					source,
				);
				if (entry === undefined) delete targets[unit];
				else targets[unit] = entry;
			}
		}
	});
}
