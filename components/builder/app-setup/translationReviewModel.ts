/**
 * What the Languages row's Mark as reviewed commits.
 *
 * An ordinary translation whose source has since dropped or gained a
 * reference no longer holds the source's references. Reviewing it as it
 * stands keeps the values it shows, which a person may choose for a
 * question's or choice's text: the review is then that person's own save of
 * the same words, marked as showing values of its own. Every other review
 * confirms the entry as it is.
 */

import type { Mutation } from "@/lib/doc/types";
import {
	authoredTranslationValueMode,
	type LanguageTag,
	type LocalizedTranslationUnit,
	reviewedTranslationValueMode,
	translationEntryIntegrityIssue,
} from "@/lib/domain";

export function reviewTranslationMutation(
	unit: LocalizedTranslationUnit,
	sourceLanguage: LanguageTag,
): Mutation | undefined {
	const entry = unit.explicit;
	if (entry === undefined) return undefined;
	const value = structuredClone(entry.value);
	const authored = authoredTranslationValueMode(unit, value);
	if (
		translationEntryIntegrityIssue(unit, {
			value,
			...reviewedTranslationValueMode(unit, entry),
		}) !== undefined &&
		translationEntryIntegrityIssue(unit, { value, ...authored }) === undefined
	)
		return {
			kind: "setTranslation",
			language: unit.language,
			unitId: unit.id,
			entry: {
				value,
				...authored,
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: sourceLanguage,
			},
		};
	return {
		kind: "reviewTranslation",
		language: unit.language,
		unitId: unit.id,
		expectedSourceFingerprint: entry.sourceFingerprint,
		sourceFingerprint: unit.sourceFingerprint,
		value,
	};
}
