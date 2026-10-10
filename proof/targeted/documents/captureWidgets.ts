/**
 * `targeted-capture-widgets` (a harness contract: every question a worker
 * answers by a gesture is answered): a survey holding one question of each
 * kind a worker answers with something other than typed text, an image, a
 * sound, a video, a document, a signature and a location, then a text. Each
 * reader the lane runs gives each its answer the way a worker does
 * (`proof/webapps/test_widgets.py` holds the Web Apps client and
 * Formplayer's walk to it): Formplayer's walk uploads the answer table's file
 * for each file question, the client chooses the same file through the
 * widget's own file input, draws the signature on its pad and drags the
 * location's map, and a device picks, records and draws each through its own
 * screens.
 *
 * Fixed values: the form holds the text answer.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function captureWidgets() {
	const id = "targeted-capture-widgets";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Capture widgets",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "image",
								uuid: uuid("photo"),
								id: "photo",
								label: proseText("Photo"),
							}),
							f({
								kind: "audio",
								uuid: uuid("voice"),
								id: "voice",
								label: proseText("Voice note"),
							}),
							f({
								kind: "video",
								uuid: uuid("clip"),
								id: "clip",
								label: proseText("Clip"),
							}),
							f({
								kind: "file",
								uuid: uuid("letter"),
								id: "letter",
								label: proseText("Letter"),
							}),
							f({
								kind: "signature",
								uuid: uuid("signed"),
								id: "signed",
								label: proseText("Signature"),
							}),
							f({
								kind: "geopoint",
								uuid: uuid("place"),
								id: "place",
								label: proseText("Place"),
							}),
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: [
			"the Web Apps client and Formplayer answer every question a worker answers with a gesture",
		],
		doc,
		expected: {
			intent: [answerHeld("note-held", form, "/data/note", "proof")],
		},
	});
}
