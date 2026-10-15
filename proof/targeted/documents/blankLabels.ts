/**
 * `targeted-blank-labels` (defect 13, a text blank in every language): a
 * survey whose one form holds a question whose label is blank in every
 * language and that names no media, a question whose label names an image
 * and holds no text, and a single select one of whose choices names an image
 * and holds no text.
 *
 * Vellum's save writes no itext item for a text blank in every language and
 * drops the reference to it (`javaRosa/util.js::getItextItemsFromMugs`). So
 * Nova writes no `<label>` and no item for a leaf question's label blank in
 * every language with no media, which is what a save leaves; a label with
 * media keeps its item, its media forms and its empty text; and a choice
 * blank in every language keeps its label only through its media, since
 * Nova refuses one with neither (`SELECT_OPTION_LABEL_EMPTY`). The document
 * shows no difference after either of Vellum's saves, and HQ builds it after
 * both.
 *
 * Fixed values: the form holds each answer, the choice named by its 1-based
 * position, as Core's evaluation takes a select's answer.
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

export function blankLabels() {
	const id = "targeted-blank-labels";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Water points",
		modules: [
			{
				uuid: uuid("module"),
				name: "Water points",
				forms: [
					{
						uuid: form,
						name: "Inspect a water point",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("unlabelled"),
								id: "unlabelled",
								label: proseText(""),
							}),
							f({
								kind: "text",
								uuid: uuid("pictured"),
								id: "pictured",
								label: proseText(""),
								label_media: { image: mediaIds.label },
							}),
							f({
								kind: "single_select",
								uuid: uuid("source"),
								id: "source",
								label: proseText("Which source is it?"),
								options: [
									{ value: "well", label: proseText("Well") },
									{
										value: "pump",
										label: proseText(""),
										media: { image: mediaIds.option },
									},
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
		rows: ["13, a text blank in every language"],
		doc,
		...(media !== undefined && { media }),
		expected: {
			intent: [
				answerHeld("unlabelled-held", form, "/data/unlabelled", "proof"),
				answerHeld("pictured-held", form, "/data/pictured", "proof"),
				{
					id: "pictured-choice-held",
					export: "local",
					form,
					request: {
						answers: [{ path: "/data/source", value: "2" }],
						expressions: ["/data/source"],
					},
					expect: [
						{ pointer: "/answers/0/result", value: "ok" },
						{ pointer: "/values/0/value", value: "pump" },
					],
				},
			],
		},
	});
}
