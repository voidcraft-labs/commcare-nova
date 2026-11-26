/**
 * `targeted-label-content`: a survey whose first question's label holds the
 * four other contents a label may hold beside its text and media
 * (`lib/domain/labelForms.ts`, `label_media.videoInline`): an extended text,
 * a QR code, a spoken text and an inline video, beside a label image. Its
 * label shows as typed, so the label's entry has no markdown form and both
 * runtimes show the extended text in the label's place (Core's
 * `FormEntryCaption.getLongText`). The second question's label is formatted
 * and holds an extended text too: a markdown form wins on both runtimes, so
 * its label is what a worker sees.
 *
 * Formplayer hands the client the extended text as the first question's
 * caption, the formatted label as the second's markdown caption, the label
 * image, and nothing of the QR code, the spoken text or the inline video
 * (`api/json/PromptToJson.java`); Web Apps shows the same
 * (`proof/formplayer/test_label_content.py`, `proof/webapps/test_label_content.py`).
 * Android draws the inline video in the image's place and shows the speaker
 * button (`MediaLayout.setAVT`, `buildComprehensiveLayout`); its witness runs
 * where the lane's Android SDK is pinned.
 *
 * The first question's constraint takes `proof`, the answer table's second
 * text, and refuses its first, which ends in white space.
 *
 * Fixed values: the form holds the answer the constraint took.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { proseText } from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function labelContent() {
	const id = "targeted-label-content";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Label content",
		modules: [
			{
				uuid: uuid("module"),
				name: "Families",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("family_name"),
								id: "family_name",
								label: proseText("Name"),
								plainLabel: true,
								extended_text: proseText("Write the name the family uses"),
								qr_code: proseText("FAMILY-17"),
								spoken_text: proseText("Say the family name"),
								label_media: {
									image: mediaIds.label,
									videoInline: mediaIds.video,
								},
								validate: ". = 'proof'",
								validate_msg: proseText("Write proof"),
							}),
							f({
								kind: "label",
								uuid: uuid("note"),
								id: "note",
								label: proseText("**Thank** the family"),
								extended_text: proseText("Extended thanks"),
							}),
						],
					},
				],
			},
		],
	});
	const media = uploadedMedia(mediaManifest());
	return targetedDocument({
		id,
		rows: [
			"a question's extended text shows in its label's place where the label shows as typed, and a formatted label wins",
			"Web Apps shows no QR code, spoken text or inline video of a label",
		],
		doc,
		...(media !== undefined && { media }),
		expected: {
			intent: [
				answerHeld("family-name-held", form, "/data/family_name", "proof"),
			],
		},
	});
}
