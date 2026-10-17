/**
 * `targeted-media-slots` (defect 16, the media slots Nova offers): a survey
 * whose one group holds one question that names an image, a sound and a
 * video on its label, beside a hint and a validation message that carry text
 * alone. The group's label, the hint and the message held media before
 * defect 16 took those slots out of the model; Formplayer's and the Web Apps
 * client's tests write the form as Nova emitted it then over a fork of this
 * document's published app (`proof/formplayer/media_slots/`), and read where
 * each slot is drawn: Formplayer's answers and the Web Apps client's screens
 * (`proof/formplayer/test_media_slots.py`, `proof/webapps/test_media_slots.py`).
 * The question's label media stays Nova's own export, the accepted case, and
 * a device's screens hold it in every walk of every state a shard serves.
 *
 * The question's constraint takes `proof`, the answer table's second text,
 * and refuses its first, which ends in white space: every walk is shown the
 * validation message once and then goes on through the form.
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

export function mediaSlots() {
	const id = "targeted-media-slots";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Media slots",
		modules: [
			{
				uuid: uuid("module"),
				name: "Households",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "group",
								uuid: uuid("household"),
								id: "household",
								label: proseText("Household"),
								children: [
									f({
										kind: "text",
										uuid: uuid("address"),
										id: "address",
										label: proseText("Address"),
										label_media: {
											image: mediaIds.label,
											audio: mediaIds.audio,
											video: mediaIds.video,
										},
										hint: proseText("Write the street"),
										validate: ". = 'proof'",
										validate_msg: proseText("Write proof"),
									}),
								],
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
		rows: ["16"],
		doc,
		...(media !== undefined && { media }),
		expected: {
			intent: [
				answerHeld("address-held", form, "/data/household/address", "proof"),
			],
		},
	});
}
