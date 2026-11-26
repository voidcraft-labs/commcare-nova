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
// (`MediaLayout.buildComprehensiveLayout`). Web Apps draws none of the inline
// video, the QR code and the speaker button (`labelInlineVideo`,
// `labelQrCode`, `labelSpeech`). A question Android shows compact draws only
// its text, which the caller's compact branch renders without consulting
// this.

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
	/** The label media the pane draws: the inline video where the platform
	 *  plays one, and the image left out where an inline video or a QR code
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

/** The caption the worker reads. Repeat action captions use the long title
 *  without the markdown preference, as Core's getRepeatText does. */
export function presentedLabelText(
	field: Field | undefined,
	showsAsTyped: boolean,
	state: LabelResolution,
): ShownLabelText | undefined {
	if (!field) return undefined;
	const label = "label" in field ? field.label : undefined;
	const extended = showsAsTyped ? heldText(field, "extended_text") : undefined;
	return extended !== undefined
		? {
				slot: "extended_text",
				template: extended,
				resolved: state.resolvedLabelTexts?.extended_text,
			}
		: label !== undefined
			? { slot: "label", template: label, resolved: state.resolvedLabel }
			: undefined;
}

export function labelPresentation(
	field: Field,
	labelShowsAsTyped: boolean,
	rules: Pick<
		PreviewPlatformRules,
		"labelInlineVideo" | "labelQrCode" | "labelSpeech"
	>,
	state: LabelResolution,
	project: (template: ProseTemplate) => string,
): LabelPresentation {
	const text = presentedLabelText(field, labelShowsAsTyped, state);
	const media = "label_media" in field ? field.label_media : undefined;
	const inlineVideo =
		rules.labelInlineVideo === "played" ? media?.videoInline : undefined;
	// The inline video takes the place of the QR code and the image alike.
	const qrTemplate =
		rules.labelQrCode === "drawn" && inlineVideo === undefined
			? heldText(field, "qr_code")
			: undefined;
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
	const replacesImage = inlineVideo !== undefined || qrCode !== undefined;
	return {
		text,
		media:
			media === undefined
				? undefined
				: {
						...media,
						videoInline: inlineVideo,
						...(replacesImage && { image: undefined }),
					},
		// An empty QR text still takes the image's place: Android's encoder
		// draws nothing for it (`setupQRView` catches the failure).
		qrCode: qrCode === "" ? undefined : qrCode,
		speech,
	};
}
