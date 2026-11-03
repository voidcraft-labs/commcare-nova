/**
 * Which groups `main` showed one screen at a time, frozen: a copy of
 * `2f985ed6:lib/domain/platformUses.ts::groupLabelShows` (module-private at
 * `main`) over a `RawDocument`.
 *
 * `main`'s XForm builder wrote `appearance="field-list"` on a group exactly
 * where its label shows in some language of the app, read as CommCare's
 * localization reads it: in each language, the label's current translation
 * or, where it has none, the source label; a value blank in that language
 * takes the form builder's fill (`2f985ed6:lib/domain/translationFill.ts::
 * filledProse`), so the label shows where any language holds text, and a
 * translation alone shows a label whose source is blank. A translation is
 * current where its source fingerprint matches the label it was made from
 * and it keeps that label's references
 * (`2f985ed6:lib/domain/translationUnits.ts::storedTranslation`). Step 5
 * stores the flag instead (`fieldList`); the cutover reads this rule to set
 * it where `main` showed it (Q4, `lib/doc/groupFieldLists.ts::
 * planGroupFieldLists`).
 *
 * It imports only head modules step 5 leaves as `main` had them:
 * `lib/domain/localization.ts`.
 */

import {
	makeTranslationUnitId,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
} from "@/lib/domain/localization";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import {
	isRecord,
	rawFieldsInDataOrder,
	rawFormsInOrder,
	recordAt,
	stringAt,
} from "./rawForms";

/** The stored localization, or `main`'s English-only default where the
 *  column is NULL (`localization.ts::effectiveAppLocalization`). */
function effectiveLocalization(raw: RawDocument): {
	readonly sourceLanguage: string;
	readonly languageOrder: readonly string[];
	readonly translations: JsonRecord;
} {
	const stored = isRecord(raw.localization) ? raw.localization : undefined;
	if (stored === undefined)
		return { sourceLanguage: "eng", languageOrder: ["eng"], translations: {} };
	const order = stored.languageOrder;
	return {
		sourceLanguage: stringAt(stored, "sourceLanguage") ?? "eng",
		languageOrder: Array.isArray(order)
			? order.filter(
					(language): language is string => typeof language === "string",
				)
			: [],
		translations: recordAt(stored, "translations") ?? {},
	};
}

/** `translationUnits.ts::proseReferenceIdentity`. */
function referenceIdentity(part: JsonRecord): string | null {
	switch (part.kind) {
		case "field-ref":
			return `field-ref\0${stringAt(part, "uuid")}`;
		case "case-ref":
			return `case-ref\0${stringAt(part, "caseType")}\0${stringAt(part, "property")}`;
		case "user-property-ref":
			return `user-property-ref\0${stringAt(part, "userPropertyUuid")}`;
		case "user-ref":
			return `user-ref\0${stringAt(part, "property")}`;
		default:
			return null;
	}
}

function parts(template: Json | undefined): readonly Json[] {
	return isRecord(template) && Array.isArray(template.parts)
		? template.parts
		: [];
}

/** `translationUnits.ts::proseReferenceSignature`. */
function referenceSignature(template: Json | undefined): string {
	return JSON.stringify(
		parts(template)
			.filter(
				(part): part is JsonRecord => isRecord(part) && part.kind !== "text",
			)
			.map(referenceIdentity)
			.sort(),
	);
}

/** The source's fingerprint, or undefined where the label is no prose
 *  template the fingerprint can read: no translation is current for it. */
function sourceFingerprint(label: Json): string | undefined {
	try {
		return translationSourceFingerprint("prose", label as never);
	} catch {
		return undefined;
	}
}

/** Whether `fieldUuid`'s label shows in some language of the app. */
export function groupLabelShows(raw: RawDocument, fieldUuid: string): boolean {
	const label = raw.fields[fieldUuid]?.label;
	if (label === undefined) return false;
	const localization = effectiveLocalization(raw);
	const unitId = makeTranslationUnitId("field", fieldUuid, "label");
	const fingerprint = sourceFingerprint(label);
	const storedValue = (language: string): Json => {
		if (language === localization.sourceLanguage) return label;
		const explicit = recordAt(
			recordAt(localization.translations, language),
			unitId,
		);
		if (explicit === undefined) return label;
		const current =
			fingerprint !== undefined &&
			translationSourceFingerprintsEqual(
				stringAt(explicit, "sourceFingerprint") ?? "",
				fingerprint,
			) &&
			isRecord(explicit.value) &&
			referenceSignature(explicit.value) === referenceSignature(label);
		return current ? (explicit.value as Json) : label;
	};
	return localization.languageOrder.some(
		(language) => parts(storedValue(language)).length > 0,
	);
}

/** Every group of every form whose label shows, forms in menu order and
 *  groups in data-tree order. */
export function labelledGroups(raw: RawDocument): readonly string[] {
	return rawFormsInOrder(raw).flatMap(({ formUuid }) =>
		rawFieldsInDataOrder(raw, formUuid).filter(
			(fieldUuid) =>
				stringAt(raw.fields[fieldUuid], "kind") === "group" &&
				groupLabelShows(raw, fieldUuid),
		),
	);
}
