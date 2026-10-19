// lib/preview/engine/formText.ts
//
// A form's own text as CommCare holds it once the form is parsed: the itext
// table `jr:itext(id)` reads in the form's language, and each select
// question's written choices, which `jr:choice-name(value, path)` reads
// (`org/javarosa/core/model/FormDef.java::initEvalContext`).
//
// Both come from the projections the XForm emitter writes: the itext ids of
// `lib/commcare/xform/itextIds.ts` and, for each id, the text the form
// builder's fill gives in that language (`lib/domain/translationFill.ts`).
// The paths are the ones the Preview print of `choice-name` names, so a
// lookup by path finds the question the printed call names.

import {
	formItextUnits,
	itextIdFor,
	itextTranslationUnitId,
} from "@/lib/commcare/xform/itextIds";
import { formExpressionSlotValues } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type Field,
	fieldKindCarriesValidation,
	filledProse,
	isContainer,
	type LanguageTag,
	type Media,
	printProseTemplate,
	proseTemplateIsEmpty,
	snapshotTranslationUnits,
	type Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { Expression, ItextUnit } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import type { XPathFormText } from "../xpath/types";
import { previewFormNodeProjection } from "./formExpressionRuntime";

const EMPTY_FORM_TEXT: XPathFormText = { itext: {}, selects: {} };

function slotMedia(field: Field, key: string): Media | undefined {
	return (field as unknown as Record<string, Media | undefined>)[key];
}

function mediaHoldsAsset(media: Media | undefined): boolean {
	return (
		media !== undefined &&
		Object.values(media).some((asset) => typeof asset === "string")
	);
}

/** Whether the XForm writes an itext entry for this unit at all: an option
 * label always, a question's label, hint and help only on a visible
 * question, a validation message only where the question validates, and
 * any of these only when some language holds text or the slot carries
 * media (`lib/commcare/xform/builder.ts`, `addItext`). */
function itextEntryWritten(
	field: Field,
	unit: ItextUnit,
	anyText: boolean,
): boolean {
	switch (unit.role) {
		case "select-option-label":
			return true;
		case "field-label":
			return (
				field.kind !== "hidden" &&
				(anyText ||
					(!isContainer(field) &&
						mediaHoldsAsset(slotMedia(field, "label_media"))))
			);
		case "field-hint":
			return field.kind !== "hidden" && anyText;
		case "field-help":
			return (
				field.kind !== "hidden" &&
				(anyText || mediaHoldsAsset(slotMedia(field, "help_media")))
			);
		case "field-validation-message":
			return fieldKindCarriesValidation(field.kind) && anyText;
	}
}

function readsFormText(expression: Expression): boolean {
	let found = false;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "itext" || node.kind === "choice-name") found = true;
	});
	return found;
}

/** Whether any of a form's questions or its own slots reads its text, so
 * its evaluations need the table at all. */
export function formReadsFormText(doc: BlueprintDoc, formUuid: Uuid): boolean {
	return formExpressionSlotValues(doc, formUuid).some(({ expression }) =>
		readsFormText(expression),
	);
}

/**
 * The text table of one form in one language. `language` absent reads the
 * app's default language, the locale a device starts a form in.
 */
export function previewFormText(
	doc: BlueprintDoc,
	formUuid: Uuid,
	language?: LanguageTag,
): XPathFormText {
	const form = formStructure(doc, formUuid);
	if (form === undefined) return EMPTY_FORM_TEXT;
	const localization = effectiveAppLocalization(doc.localization);
	/* A worker language the app does not hold (a platform locale) reads the
	 * app's default, as a device whose locale has no table does. */
	const current =
		language !== undefined && localization.languageOrder.includes(language)
			? language
			: localization.defaultLanguage;
	const units = snapshotTranslationUnits(doc);
	const textOf = (unit: ItextUnit, tag: LanguageTag) => {
		const translationUnit = units.get(itextTranslationUnitId(unit));
		return translationUnit === undefined
			? undefined
			: filledProse(doc, translationUnit, tag);
	};

	const itext: Record<string, string> = {};
	for (const [id, unit] of formItextUnits(form)) {
		const field = doc.fields[unit.field];
		if (field === undefined) continue;
		const anyText = localization.languageOrder.some(
			(tag) => !proseTemplateIsEmpty(textOf(unit, tag)),
		);
		if (!itextEntryWritten(field, unit, anyText)) continue;
		const template = textOf(unit, current);
		itext[id] = template === undefined ? "" : printProseTemplate(template, doc);
	}

	const projection = previewFormNodeProjection(doc, formUuid);
	const selects: Record<string, readonly (readonly [string, string])[] | null> =
		{};
	for (const field of form.fields.values()) {
		if (field.choices === undefined) continue;
		const path = projection.path({ kind: "field", uuid: field.uuid });
		if (path === undefined) continue;
		if (field.choices.kind !== "inline") {
			selects[path.toXPath()] = null;
			continue;
		}
		selects[path.toXPath()] = field.choices.options.map((option) => {
			const id = itextIdFor(
				doc,
				{ field: field.uuid, option: option.uuid, role: "select-option-label" },
				form,
			);
			return [option.value, id === undefined ? "" : (itext[id] ?? "")];
		});
	}
	return { itext, selects };
}
