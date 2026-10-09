/**
 * `targeted-media-slots` (defect 16, the media slots Nova offers): a survey
 * whose one group's label names an image, and whose one question inside it
 * names an image, a sound and a video on its label, an image on its hint and
 * an image on its validation message. Each runtime the lane runs is shown
 * every slot Nova writes, so what a worker sees of each is read where it is
 * drawn: Formplayer's answers and the Web Apps client's screens
 * (`proof/formplayer/test_media_slots.py`, `proof/webapps/test_media_slots.py`),
 * and a device's screens in every walk the Android stage makes.
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
								label_media: { image: mediaIds.option },
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
										hint_media: { image: mediaIds.icon },
										validate: ". = 'proof'",
										validate_msg: proseText("Write proof"),
										validate_msg_media: { image: mediaIds.alias },
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
