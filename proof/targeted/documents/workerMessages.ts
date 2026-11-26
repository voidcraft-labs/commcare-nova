import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { proseText } from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** The same signed questionnaire is opened in the editor, the web client and on a phone. Its documents form
 * holds the one starting value an attachment question keeps, a blank one, on the picture; the witnesses write a
 * file name as another question's starting value past Nova's gate to show what each platform does with it. */
export function workerMessages() {
	const id = "targeted-worker-messages";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Visit instructions",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Review the visit",
						type: "survey",
						fields: [
							f({
								kind: "label",
								uuid: uuid("notice"),
								id: "notice",
								label: proseText("Read the visit notes"),
								hint: proseText("Read this first"),
								help: proseText("Open the notes before continuing"),
								help_media: { image: mediaIds.label },
							}),
							f({
								kind: "label",
								uuid: uuid("confirmed"),
								id: "confirmed",
								label: proseText("I reviewed the notes"),
								askForConfirmation: true,
								required: "true()",
								validate: ". = 'OK'",
								validate_msg: proseText("Confirm that you reviewed the notes"),
							}),
							f({
								kind: "label",
								uuid: uuid("optional"),
								id: "optional",
								label: proseText("Optional follow-up"),
								askForConfirmation: true,
								default_value: "'later'",
							}),
							f({
								kind: "geopoint",
								uuid: uuid("location"),
								id: "location",
								label: proseText("Visit location"),
								help: proseText("Stand outside"),
								validate: "true()",
								validate_msg: proseText("Check the coordinates"),
							}),
							f({
								kind: "text",
								uuid: uuid("acknowledged_note"),
								id: "acknowledged_note",
								label: proseText("Follow up after confirmation"),
								relevant: "#form/confirmed = 'OK'",
							}),
						],
					},
					{
						uuid: uuid("documents"),
						name: "Visit documents",
						type: "survey",
						fields: [
							f({
								kind: "file",
								uuid: uuid("report"),
								id: "report",
								label: proseText("Previous report"),
								validate: ". != 'blocked.pdf'",
							}),
							f({
								kind: "image",
								uuid: uuid("photo"),
								id: "photo",
								label: proseText("Optional picture"),
								default_value: "''",
								help_media: { image: mediaIds.label },
							}),
							f({
								kind: "file",
								uuid: uuid("replacement"),
								id: "replacement",
								label: proseText("Current report"),
								required: "true()",
								validate: ". != 'blocked.pdf'",
								validate_msg: proseText("Choose the current report"),
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
		doc,
		...(media !== undefined && { media }),
		rows: [
			"Message confirmation and ordinary question logic on messages and attachments",
		],
		expected: {
			intent: [answerHeld("confirmation", form, "/data/confirmed", "OK")],
		},
	});
}
