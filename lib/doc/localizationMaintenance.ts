/** Dependent-state maintenance for translation overlays. */

import type { Draft } from "immer";
import type { BlueprintDoc } from "@/lib/domain";
import { collectTranslationUnits } from "@/lib/domain";

/**
 * Translation entries are owned by a deterministic unit in the current
 * Blueprint. Removing that owner (or changing a semantic keyed item into a
 * different unit) removes its dependent overlays in the same command, just as
 * removing a form removes its fields. Source text edits keep the same unit and
 * therefore retain the old entry as an explicit out-of-date value.
 */
export function pruneOrphanTranslationEntries(
	draft: Draft<BlueprintDoc>,
): void {
	if (draft.localization === undefined) return;
	const liveUnitIds = new Set(
		collectTranslationUnits(draft as unknown as BlueprintDoc).map(
			(unit) => unit.id,
		),
	);
	for (const translations of Object.values(draft.localization.translations)) {
		for (const unitId of Object.keys(translations)) {
			if (!liveUnitIds.has(unitId)) delete translations[unitId];
		}
	}
}

/**
 * An absent root is the canonical spelling of the exact English-only state,
 * so a batch that ends there deletes the materialized shell instead of
 * persisting a second spelling of the same document.
 */
export function dematerializeEnglishOnlyLocalization(
	draft: Draft<BlueprintDoc>,
): void {
	const localization = draft.localization;
	if (
		localization?.sourceLanguage === "eng" &&
		localization.defaultLanguage === "eng" &&
		localization.languageOrder.length === 1 &&
		localization.languageOrder[0] === "eng" &&
		Object.keys(localization.translations).length === 0
	) {
		delete draft.localization;
	}
}
