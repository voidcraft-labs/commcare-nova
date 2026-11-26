// lib/domain/labelForms.ts
//
// A question's label may hold three more texts beside the label itself, each
// its own prose slot with its own translation, each written as one more form
// of the label's itext entry:
//
//   - `extended_text` (`<value form="long">`): the text a runtime shows in
//     place of the label where the label has no markdown form. Core's
//     `FormEntryCaption.getLongText` reads `long` first and the label's own
//     value after it; Formplayer sends it as the question's `caption` beside
//     `caption_markdown` (`PromptToJson`), and Web Apps shows the markdown
//     form where one is present; Android's `QuestionWidget.setTextFromPrompt`
//     reads `getMarkdownText()` first and `getLongText()` after it. Android
//     also reads it aloud where text to speech is on and no `tts` form is
//     present (`QuestionWidget.addQuestionText`).
//   - `qr_code` (`<value form="qrcode">`): Android draws it as a QR code in
//     the label's media pane, in place of the label image, unless an inline
//     video is present (`MediaLayout.setAVT`). Web Apps ignores it.
//   - `spoken_text` (`<value form="tts">`): Android shows a speaker button
//     that reads it aloud where the label has no audio
//     (`MediaLayout.buildComprehensiveLayout`), whatever the text to speech
//     preference. Web Apps ignores it.
//
// Android draws neither the QR code nor the speaker button on a question shown
// compact (`QuestionWidget.addQuestionText` puts only the text in a compact
// layout). Every form is evaluated where the label is, `<output>` values
// filled at the question (`FormEntryCaption.substituteStringArgs`), so each
// slot is a `ProseTemplate` with the label's reference contract.
//
// CommCare HQ's build accepts these forms beside a label's default value
// (`xform.py::XForm.localize` checks forms only where the default value is
// missing), and its form builder loads and writes every form of a text
// (`javaRosa/plugin.js`, "Add Other Content", `isCustomAllowed`).

import type { Field } from "./fields";
import { type FieldKind, fieldKindDeclaresKey } from "./fields";
import type { ProseTemplate } from "./prose";

/** The three label text slots, in the order the emitter writes their forms. */
export const LABEL_TEXT_SLOTS = [
	"extended_text",
	"qr_code",
	"spoken_text",
] as const;
export type LabelTextSlot = (typeof LABEL_TEXT_SLOTS)[number];

/** Each slot's itext form on the wire. */
export const LABEL_TEXT_WIRE_FORMS: Readonly<
	Record<LabelTextSlot, "long" | "qrcode" | "tts">
> = {
	extended_text: "long",
	qr_code: "qrcode",
	spoken_text: "tts",
};

/** The slot an itext form name holds, or undefined for any other form. */
export function labelTextSlotOfWireForm(
	form: string,
): LabelTextSlot | undefined {
	for (const slot of LABEL_TEXT_SLOTS)
		if (LABEL_TEXT_WIRE_FORMS[slot] === form) return slot;
	return undefined;
}

/** Each slot's name, as Nova says it to people. */
export const LABEL_TEXT_SLOT_LABELS: Readonly<Record<LabelTextSlot, string>> = {
	extended_text: "Extended text",
	qr_code: "QR code",
	spoken_text: "Spoken text",
};

/** Whether a field kind carries the label text slots: exactly the kinds whose
 *  label carries media, a visible question's label. */
export function fieldKindCarriesLabelTexts(kind: FieldKind): boolean {
	return fieldKindDeclaresKey(kind, "extended_text");
}

/** A field's text in one label text slot, where the kind carries it. */
export function labelTextOf(
	field: Field,
	slot: LabelTextSlot,
): ProseTemplate | undefined {
	return slot in field
		? (field as Partial<Record<LabelTextSlot, ProseTemplate>>)[slot]
		: undefined;
}

/** Every field prose slot but a choice's label, each its own translation
 *  unit keyed by the slot's name: the label, hint, help text and validation
 *  message, then the label's other texts. */
export const FIELD_PROSE_SLOTS = [
	"label",
	"hint",
	"help",
	"validate_msg",
	"addFirstLabel",
	"addLabel",
	...LABEL_TEXT_SLOTS,
] as const;
export type FieldProseSlot = (typeof FIELD_PROSE_SLOTS)[number];

const FIELD_PROSE_SLOT_NAMES: ReadonlySet<string> = new Set(FIELD_PROSE_SLOTS);

/** Whether a name is one of a field's own prose slots. */
export function isFieldProseSlot(name: string): name is FieldProseSlot {
	return FIELD_PROSE_SLOT_NAMES.has(name);
}
