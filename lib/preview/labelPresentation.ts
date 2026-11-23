// lib/preview/labelPresentation.ts
//
// What a running question's label shows, from its label, its other texts
// (`lib/domain/labelForms.ts`) and its media, for the platform Preview plays.
//
// The text: a label with a markdown form shows that form on both runtimes
// (Web Apps reads Formplayer's `caption_markdown` before `caption`; Android's
// `QuestionWidget.setTextFromPrompt` reads `getMarkdownText()` first). A label
// shown as typed writes no markdown form, so both show Core's
// `getLongText()`: the extended text where the label holds one, the label
// otherwise. So the extended text shows on both platforms exactly where the
// label shows as typed; no platform rule decides it.
//
// The media pane: Android draws one of the inline video, the QR code and the
// label image, in that order (`MediaLayout.setAVT`), and a speaker button for
// the spoken text where the label has no audio
// (`MediaLayout.buildComprehensiveLayout`). Web Apps draws neither the QR code
// nor the speaker button (`labelQrCode`, `labelSpeech`). A question Android
// shows compact draws only its text, which the caller's compact branch
// renders without consulting this.

import type { Field, LabelTextSlot, Media, ProseTemplate } from "@/lib/domain";
import { labelTextOf } from "@/lib/domain/labelForms";
import type { PreviewPlatformRules } from "./platform";

/** A label text the runtime shows, with its refs resolved where it holds any. */
export interface ShownLabelText {
	readonly slot: "label" | LabelTextSlot;
	readonly template: ProseTemplate;
	readonly resolved: string | undefined;
}

export interface LabelPresentation {
	/** The text in the label's place, or undefined where the field holds no
	 *  label and nothing replaces it. */
	readonly text: ShownLabelText | undefined;
	/** The label media the pane draws: the image left out where a QR code
	 *  takes its place. */
	readonly media: Media | undefined;
	/** The QR code drawn in the label image's place, as its encoded text. */
	readonly qrCode: string | undefined;
	/** The text the speaker button reads aloud. */
	readonly speech: string | undefined;
}

export interface LabelResolution {
	readonly resolvedLabel?: string;
	readonly resolvedLabelTexts?: Readonly<
		Partial<Record<LabelTextSlot, string>>
	>;
}

/** A label text slot's template where the field holds one, a blank one
 *  included: a runtime reads a present form as it stands. */
function heldText(
	field: Field,
	slot: LabelTextSlot,
): ProseTemplate | undefined {
	return labelTextOf(field, slot);
}

/** A template's text as the worker sees it: its resolved value, or its
 *  literal text where it holds no reference. */
function shownString(
	template: ProseTemplate,
	resolved: string | undefined,
	project: (template: ProseTemplate) => string,
): string {
	return resolved ?? project(template);
}

export function labelPresentation(
	field: Field,
	labelShowsAsTyped: boolean,
	rules: Pick<PreviewPlatformRules, "labelQrCode" | "labelSpeech">,
	state: LabelResolution,
	project: (template: ProseTemplate) => string,
): LabelPresentation {
	const label = "label" in field ? field.label : undefined;
	const extended = labelShowsAsTyped
		? heldText(field, "extended_text")
		: undefined;
	const text: ShownLabelText | undefined =
		extended !== undefined
			? {
					slot: "extended_text",
					template: extended,
					resolved: state.resolvedLabelTexts?.extended_text,
				}
			: label !== undefined
				? { slot: "label", template: label, resolved: state.resolvedLabel }
				: undefined;
	const media = "label_media" in field ? field.label_media : undefined;
	const qrTemplate =
		rules.labelQrCode === "drawn" ? heldText(field, "qr_code") : undefined;
	const qrCode =
		qrTemplate === undefined
			? undefined
			: shownString(qrTemplate, state.resolvedLabelTexts?.qr_code, project);
	const speechTemplate =
		rules.labelSpeech === "button" && media?.audio === undefined
			? heldText(field, "spoken_text")
			: undefined;
	const speech =
		speechTemplate === undefined
			? undefined
			: shownString(
					speechTemplate,
					state.resolvedLabelTexts?.spoken_text,
					project,
				);
	return {
		text,
		media:
			qrCode !== undefined && media?.image !== undefined
				? { ...media, image: undefined }
				: media,
		// An empty QR text still takes the image's place: Android's encoder
		// draws nothing for it (`setupQRView` catches the failure).
		qrCode: qrCode === "" ? undefined : qrCode,
		speech,
	};
}
