/**
 * The XForm writes field media on a question's label and help alone (defect
 * 16): no CommCare runtime draws media on a hint, a validation message, or a
 * group's or repeat's label, so the emitter writes none there, even for a
 * field that still holds one of the retired keys, which no schema admits.
 * The question's own label media is the accepted case beside them.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { buildXForm } from "../xform/builder";
import { mediaIds, mediaManifest } from "./mediaWireFixtures";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const MEDIA_FORMS = ["image", "audio", "video", "video-inline"];

function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return [
		...(node.name === name ? [node] : []),
		...node.children.flatMap((child) => descendants(child, name)),
	];
}

/** Each itext entry's id with the forms its values carry. */
function entryForms(root: XmlEvidence): Map<string, (string | undefined)[]> {
	return new Map(
		descendants(root, "text").map((entry) => [
			entry.attributes.id,
			entry.children.map((value) => value.attributes.form),
		]),
	);
}

describe("media slot emission", () => {
	it("writes media on a question's label and help, and nowhere else", () => {
		const bundle = {
			image: mediaIds.label,
			audio: mediaIds.audio,
			video: mediaIds.video,
		};
		const doc = buildDoc({
			appName: "Media slots",
			modules: [
				{
					name: "Households",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "group",
									id: "household",
									label: proseText("Household"),
									children: [
										f({
											kind: "text",
											id: "address",
											label: proseText("Address"),
											label_media: bundle,
											hint: proseText("Write the street"),
											help: proseText("The one on the door"),
											help_media: { audio: mediaIds.audio },
											validate: ". = 'proof'",
											validate_msg: proseText("Write proof"),
										}),
									],
								}),
								f({
									kind: "repeat",
									id: "rows",
									label: proseText("Rows"),
									repeat_mode: "user_controlled",
									children: [
										f({ kind: "text", id: "row", label: proseText("Row") }),
									],
								}),
							],
						},
					],
				},
			],
		});
		const field = (id: string) => {
			const found = Object.values(doc.fields).find((each) => each.id === id);
			if (found === undefined) throw new Error(`Missing field ${id}.`);
			return found;
		};
		// The retired keys, as a stored field from before the cutover held them.
		Object.assign(field("household"), { label_media: bundle });
		Object.assign(field("rows"), { label_media: bundle });
		Object.assign(field("address"), {
			hint_media: bundle,
			validate_msg_media: bundle,
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const forms = entryForms(
			readXmlEvidence(
				buildXForm(doc, formUuid, {
					xmlns: "urn:media-slots",
					assets: mediaManifest(),
				}),
			),
		);
		expect(forms.get("household-address-label")).toEqual([
			undefined,
			"markdown",
			"image",
			"audio",
			"video",
		]);
		expect(forms.get("household-address-help")).toEqual([
			undefined,
			"markdown",
			"audio",
		]);
		for (const id of [
			"household-label",
			"rows-label",
			"household-address-hint",
			"household-address-constraintMsg",
		]) {
			const values = forms.get(id);
			expect(values, id).toBeDefined();
			expect(
				values?.filter(
					(form) => form !== undefined && MEDIA_FORMS.includes(form),
				),
				id,
			).toEqual([]);
		}
	});
});
