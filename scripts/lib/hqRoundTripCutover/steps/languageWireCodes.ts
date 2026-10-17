/**
 * Step `language-wire-codes`, the first of the fixed order: writes
 * `localization.wireCodes` on every app with a stored localization root, each
 * language holding the code the pre-step grouping gave it on every export
 * (`../legacyLanguageWireCodes.ts`), so no deployed code moves. An app with
 * no stored root is the English-only state, which emits `en` with no stored
 * code, and is left as it is. Nothing a person or a worker sees changes, so
 * the step returns no change.
 */

import { legacyWireCodes } from "../legacyLanguageWireCodes";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep } from "../transform";

function isRecord(value: Json | undefined): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const languageWireCodesStep: CutoverStep = {
	id: "language-wire-codes",
	apply(document, context) {
		const localization = document.localization;
		if (localization === null) return [];
		if (!isRecord(localization)) {
			throw new Error(
				`App ${context.appId} stores a localization root that is not an object, so step language-wire-codes cannot read its languages.`,
			);
		}
		if (localization.wireCodes !== undefined) return [];
		const languageOrder = localization.languageOrder;
		if (
			!Array.isArray(languageOrder) ||
			!languageOrder.every((tag) => typeof tag === "string")
		) {
			throw new Error(
				`App ${context.appId} stores a localization root with no list of language tags, so step language-wire-codes cannot read its languages.`,
			);
		}
		(document as { localization: Json }).localization = {
			...localization,
			wireCodes: legacyWireCodes({
				languageOrder: languageOrder as readonly string[],
			}),
		};
		return [];
	},
};

/** Each language whose stored code is a suffixed one, for the scan's report. */
export function suffixedWireCodeLanguages(document: RawDocument): string[] {
	const localization = document.localization;
	if (!isRecord(localization)) return [];
	const wireCodes = localization.wireCodes;
	if (!isRecord(wireCodes)) return [];
	return Object.entries(wireCodes)
		.filter(([, code]) => typeof code === "string" && code.includes("-"))
		.map(([tag]) => tag);
}
