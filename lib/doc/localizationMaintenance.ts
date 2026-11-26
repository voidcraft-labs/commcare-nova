/** Dependent-state maintenance for translation overlays. */

import type { Draft } from "immer";
import type { BlueprintDoc } from "@/lib/domain";
import { collectTranslationUnits } from "@/lib/domain";
import {
	isEnglishOnlyLocalization,
	translationSourceFingerprintsEqual,
} from "@/lib/domain/localization";

/**
 * Translation entries are owned by a deterministic unit in the current
 * Blueprint. Removing that owner (or changing a semantic keyed item into a
 * different unit) removes its dependent overlays in the same command, just as
 * removing a form removes its fields. Source text edits keep the same unit and
 * therefore retain the old entry as an explicit out-of-date value.
 *
 * A Search screen title turned off in the source holds a unit with a blank
 * source, which every language shows as no title unless it gives itself one
 * (a translation of the blank). An entry taken from the title the source
 * had before translates nothing the unit now holds, and nothing can bring it
 * up to date (there is no source to translate), so turning the title off
 * removes it, as removing the title removed its unit.
 */
export function pruneOrphanTranslationEntries(
	draft: Draft<BlueprintDoc>,
): void {
	if (draft.localization === undefined) return;
	const units = new Map(
		collectTranslationUnits(draft as unknown as BlueprintDoc).map((unit) => [
			unit.id,
			unit,
		]),
	);
	for (const translations of [
		...Object.values(draft.localization.translations),
		draft.localization.generatedSourceWording,
	]) {
		if (!translations) continue;
		for (const [unitId, entry] of Object.entries(translations)) {
			const unit = units.get(unitId);
			if (
				unit === undefined ||
				(translations !== draft.localization.generatedSourceWording &&
					unit.role === "search-screen-title" &&
					unit.source === "" &&
					!translationSourceFingerprintsEqual(
						entry.sourceFingerprint,
						unit.sourceFingerprint,
					))
			)
				delete translations[unitId];
		}
	}
	if (!Object.keys(draft.localization.generatedSourceWording ?? {}).length)
		delete draft.localization.generatedSourceWording;
}

/**
 * An absent root is the canonical spelling of the exact English-only state,
 * so a batch that ends there deletes the materialized shell instead of
 * persisting a second spelling of the same document.
 */
export function dematerializeEnglishOnlyLocalization(
	draft: Draft<BlueprintDoc>,
): void {
	if (isEnglishOnlyLocalization(draft.localization)) {
		delete draft.localization;
	}
}
