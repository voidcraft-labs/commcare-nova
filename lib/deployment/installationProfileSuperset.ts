import {
	type BlueprintDoc,
	effectiveAppLocalization,
	filledProse,
	snapshotTranslationUnits,
	storedTranslationValue,
	TRANSLATION_FILL_ROLES,
	type TranslationEntry,
	translationValueIntegrityIssue,
} from "@/lib/domain";

/** The prior published revision is what the destination's old installations
 * run. Keep each selected language's effective text for surviving UUIDs while
 * the new app supplies text for new units. Never add this temporary union to
 * the author's document or confuse it with a completed publish. */
export function intermediateInstallationDoc(
	desired: BlueprintDoc,
	prior: BlueprintDoc,
	keepCodes: readonly string[],
): BlueprintDoc | { issue: string } {
	const before = effectiveAppLocalization(prior.localization);
	const after = effectiveAppLocalization(desired.localization);
	const localization = {
		...after,
		languageOrder: [...after.languageOrder],
		translations: { ...after.translations },
		wireCodes: { ...after.wireCodes },
	};
	const oldUnits = snapshotTranslationUnits(prior);
	for (const code of keepCodes) {
		const tag = before.languageOrder.find(
			(tag) => before.wireCodes[tag] === code,
		);
		if (!tag || localization.languageOrder.includes(tag))
			return {
				issue: `Nova cannot match the installation language “${code}” to its previous published language. Keep it in the app until you have updated the profiles in CommCare HQ.`,
			};
		localization.languageOrder.push(tag);
		localization.wireCodes[tag] = code;
		const entries: Record<string, TranslationEntry> = {};
		for (const unit of snapshotTranslationUnits(desired).values()) {
			const old = oldUnits.get(unit.id);
			const value = !old
				? unit.source
				: TRANSLATION_FILL_ROLES.has(old.role)
					? filledProse(prior, old, tag)
					: storedTranslationValue(prior, tag, old);
			if (translationValueIntegrityIssue(unit, value))
				return {
					issue: `The previous “${code}” translation for “${unit.breadcrumb.join(" / ")}” needs an edit before workers can switch installations. Keep the language in the app, update its text, then publish again.`,
				};
			entries[unit.id] = {
				value,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "copied",
				review: "reviewed",
				translatedFrom: old ? tag : after.sourceLanguage,
			};
		}
		localization.translations[tag] = entries;
	}
	return { ...desired, localization };
}
