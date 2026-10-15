/**
 * Step `option-labels`: gives each written choice of a select whose label is
 * blank in every language and that carries no image, audio or video its own
 * value as its source-language label, so the document passes
 * `SELECT_OPTION_LABEL_EMPTY` and a worker reads something where an empty
 * choice stood. It runs after every step that rewrites a choice's value
 * (the fixed order `__tests__/steps.test.ts` holds puts `option-values`
 * before it), so the label is the value the option keeps.
 *
 * Only an inline select stores choices; a lookup-backed or case-backed select
 * holds none of its own and is left as it is. A label is blank in a language
 * exactly as the validator reads it (`lib/domain/translationUnits.ts`,
 * `storedTranslation`): the source language reads the stored label, and every
 * other language reads its translation entry only where that entry is
 * current (its source fingerprint is the blank label's, and it adds no
 * reference the label lacks), and the stored label otherwise. No translation
 * entry is touched: one written against the blank label is out of date once
 * the label holds the value, so that language shows the value too.
 *
 * One `option-label-filled` line per choice, naming the form, with the
 * question's id and the choice's value.
 */

import {
	asUuid,
	makeTranslationUnitId,
	translationSourceFingerprint,
	translationSourceFingerprintsEqual,
} from "@/lib/domain";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";

function isRecord(value: Json | undefined): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The parts of a stored prose template, or undefined where it is not one. A
 * template with no parts is blank (`lib/domain/prose.ts::proseTemplateIsEmpty`);
 * a text part is never empty, so no other template is.
 */
function proseParts(value: Json | undefined): readonly Json[] | undefined {
	if (!isRecord(value)) return undefined;
	return Array.isArray(value.parts) ? value.parts : undefined;
}

/** The fingerprint a translation written against a blank label carries. */
const BLANK_LABEL_FINGERPRINT = translationSourceFingerprint("prose", {
	parts: [],
});

/**
 * Whether some language other than the source holds a current, non-blank
 * translation of a choice whose stored label is blank. A blank label holds no
 * reference, so a translation that holds one is not current.
 */
function translatedSomewhere(
	document: RawDocument,
	unitId: string,
	appId: string,
): boolean {
	const localization = document.localization;
	if (localization === null) return false;
	if (!isRecord(localization)) {
		throw new Error(
			`App ${appId} stores a localization root that is not an object, so step option-labels cannot read its translations.`,
		);
	}
	const { sourceLanguage, languageOrder, translations } = localization;
	if (!Array.isArray(languageOrder) || !isRecord(translations)) {
		throw new Error(
			`App ${appId} stores a localization root with no list of language tags or no translations, so step option-labels cannot read its translations.`,
		);
	}
	return languageOrder.some((language) => {
		if (typeof language !== "string" || language === sourceLanguage) {
			return false;
		}
		const entries = translations[language];
		const entry = isRecord(entries) ? entries[unitId] : undefined;
		if (!isRecord(entry) || typeof entry.sourceFingerprint !== "string") {
			return false;
		}
		const parts = proseParts(entry.value);
		return (
			translationSourceFingerprintsEqual(
				entry.sourceFingerprint,
				BLANK_LABEL_FINGERPRINT,
			) &&
			parts !== undefined &&
			parts.length > 0 &&
			parts.every((part) => isRecord(part) && part.kind === "text")
		);
	});
}

/** Whether a stored choice carries an image, audio or video. */
function carriesMedia(option: JsonRecord): boolean {
	const media = option.media;
	return (
		isRecord(media) &&
		(media.image !== undefined ||
			media.audio !== undefined ||
			media.video !== undefined)
	);
}

/** Every field under a parent, in document order, containers' children included. */
function fieldsUnder(document: RawDocument, parent: string): JsonRecord[] {
	return (document.fieldOrder[parent] ?? []).flatMap((uuid) => {
		const field = document.fields[uuid];
		return field === undefined ? [] : [field, ...fieldsUnder(document, uuid)];
	});
}

export const optionLabelsStep: CutoverStep = {
	id: "option-labels",
	apply(document, context) {
		const changes: DocumentChange[] = [];
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined) continue;
				for (const field of fieldsUnder(document, formUuid)) {
					const source = field.optionsSource;
					if (!isRecord(source) || source.kind !== "inline") continue;
					if (!Array.isArray(source.options)) continue;
					for (const option of source.options) {
						if (!isRecord(option) || carriesMedia(option)) continue;
						const parts = proseParts(option.label);
						if (parts === undefined) {
							throw new Error(
								`Field ${String(field.uuid)} of app ${context.appId} stores a choice whose label is not a prose template, so step option-labels cannot read it.`,
							);
						}
						if (parts.length > 0) continue;
						const unitId = makeTranslationUnitId(
							"field",
							String(field.uuid),
							"option",
							String(option.uuid),
						);
						if (translatedSomewhere(document, unitId, context.appId)) continue;
						const value = option.value;
						if (typeof value !== "string" || value === "") {
							throw new Error(
								`Field ${String(field.uuid)} of app ${context.appId} stores a choice with no label and no value, so step option-labels has nothing to show for it.`,
							);
						}
						(option as { label: Json }).label = {
							parts: [{ kind: "text", text: value }],
						};
						changes.push({
							reason: "option-label-filled",
							entity: {
								type: "form",
								uuid: asUuid(formUuid),
								nameAtMigration: String(form.name),
							},
							detail: { question: String(field.id), value },
						});
					}
				}
			}
		}
		return changes;
	},
};
