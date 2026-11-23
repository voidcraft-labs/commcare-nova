/**
 * What a running question's label shows, per platform
 * (`lib/preview/labelPresentation.ts`).
 *
 * Contract: the extended text takes the label's place on both platforms
 * exactly where the label shows as typed (no markdown form: Formplayer's
 * `caption` and Android's `getLongText()` read `long` first, while a markdown
 * form wins on both), a blank one too (Core reads a present form as it
 * stands), and is ignored where the label is formatted. Android draws the QR code in the label image's
 * place and shows a speaker button for the spoken text where the label has
 * no audio; Web Apps draws neither (`labelQrCode`, `labelSpeech`). A text
 * holding a reference shows its resolved value.
 *
 * Plausible failures: the extended text shown over a formatted label, or on
 * one platform only; a QR code or speaker button in Web Apps; the image kept
 * beside the QR code; the speaker button beside label audio; a resolved value
 * ignored.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Field, MediaAssetId, ProseTemplate } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import { labelPresentation } from "../labelPresentation";
import { previewPlatformRules } from "../platform";

const IMAGE = "asset-image" as MediaAssetId;
const AUDIO = "asset-audio" as MediaAssetId;

function card(extra: Partial<Record<string, unknown>> = {}): Field {
	return {
		uuid: testUuid("label-presentation-card"),
		id: "card",
		kind: "label",
		label: proseText("Show the card"),
		extended_text: proseText("Show the card to the nurse"),
		qr_code: proseText("ID-17"),
		spoken_text: proseText("Show the card"),
		label_media: { image: IMAGE },
		...extra,
	} as Field;
}

const project = (template: ProseTemplate) =>
	template.parts
		.map((part) => (part.kind === "text" ? part.text : "?"))
		.join("");

const WEB = previewPlatformRules("web-apps");
const ANDROID = previewPlatformRules("android");

describe("labelPresentation", () => {
	it("shows the extended text in the label's place on both platforms where the label shows as typed", () => {
		for (const rules of [WEB, ANDROID]) {
			const shown = labelPresentation(card(), true, rules, {}, project);
			expect(shown.text?.slot).toBe("extended_text");
			expect(project(shown.text?.template ?? { parts: [] })).toBe(
				"Show the card to the nurse",
			);
		}
	});

	it("shows the label where it is formatted, and a blank extended text as it stands", () => {
		for (const rules of [WEB, ANDROID]) {
			expect(
				labelPresentation(card(), false, rules, {}, project).text?.slot,
			).toBe("label");
			const blank = labelPresentation(
				card({ extended_text: proseText("") }),
				true,
				rules,
				{},
				project,
			);
			expect(blank.text?.slot).toBe("extended_text");
			expect(blank.text?.template.parts).toEqual([]);
		}
	});

	it("lets a blank QR code take the image's place and draws nothing", () => {
		const shown = labelPresentation(
			card({ qr_code: proseText("") }),
			false,
			ANDROID,
			{},
			project,
		);
		expect(shown.qrCode).toBeUndefined();
		expect(shown.media?.image).toBeUndefined();
	});

	it("reads the resolved extended text", () => {
		const shown = labelPresentation(
			card(),
			true,
			ANDROID,
			{ resolvedLabelTexts: { extended_text: "Show the card to Ada" } },
			project,
		);
		expect(shown.text?.resolved).toBe("Show the card to Ada");
	});

	it("draws the QR code in the image's place on Android, and nothing in Web Apps", () => {
		const android = labelPresentation(card(), false, ANDROID, {}, project);
		expect(android.qrCode).toBe("ID-17");
		expect(android.media?.image).toBeUndefined();
		const web = labelPresentation(card(), false, WEB, {}, project);
		expect(web.qrCode).toBeUndefined();
		expect(web.media?.image).toBe(IMAGE);
	});

	it("reads a resolved QR code", () => {
		expect(
			labelPresentation(
				card(),
				false,
				ANDROID,
				{ resolvedLabelTexts: { qr_code: "ID-42" } },
				project,
			).qrCode,
		).toBe("ID-42");
	});

	it("offers the speaker button on Android where the label has no audio", () => {
		expect(labelPresentation(card(), false, ANDROID, {}, project).speech).toBe(
			"Show the card",
		);
		expect(
			labelPresentation(
				card({ label_media: { image: IMAGE, audio: AUDIO } }),
				false,
				ANDROID,
				{},
				project,
			).speech,
		).toBeUndefined();
		expect(
			labelPresentation(card(), false, WEB, {}, project).speech,
		).toBeUndefined();
	});
});
