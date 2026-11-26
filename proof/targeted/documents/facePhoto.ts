import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function facePhoto() {
	const id = "targeted-face-photo";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Portrait visit",
		modules: [
			{
				uuid: uuid("menu"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Record visit",
						type: "survey",
						fields: [
							f({
								kind: "image",
								uuid: uuid("portrait"),
								id: "portrait",
								label: proseText("Portrait"),
								captureSource: "face-camera",
							}),
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Visit note"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		doc,
		rows: ["Face camera, uploaded picture and submitted file"],
		expected: {
			intent: [answerHeld("visit-note", form, "/data/note", "Reached")],
		},
	});
}
