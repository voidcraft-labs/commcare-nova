/**
 * The one rule of where a file plays, over real documents: which references a
 * declaration refuses, and every sentence each surface shows for one.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { builtinIconRef } from "@/lib/domain/builtinIcons";
import type { MediaFormatValue } from "@/lib/domain/multimedia";
import type { Platform } from "@/lib/domain/platforms";
import {
	assetUnavailableReason,
	attachPlatformSentence,
	browserStandIn,
	describeUnplayableReferences,
	formatUnavailableReason,
	playsOnEvery,
	playsOnLine,
	unplayableReferences,
} from "../platformPlayback";

const BOTH: readonly Platform[] = ["web-apps", "android"];
const ICO = testMediaAssetId("ico");
const AMR = testMediaAssetId("amr");
const HEVC = testMediaAssetId("hevc");
const WAV = testMediaAssetId("wav");
const PNG = testMediaAssetId("png");

const FORMATS = new Map<
	string,
	{ mediaFormat?: MediaFormatValue; mimeType: string }
>([
	[ICO, { mediaFormat: "ico", mimeType: "image/vnd.microsoft.icon" }],
	[AMR, { mediaFormat: "amr", mimeType: "audio/amr" }],
	[HEVC, { mediaFormat: "mp4-hevc", mimeType: "video/mp4" }],
	[WAV, { mediaFormat: "unplayable", mimeType: "audio/wav" }],
	[PNG, { mediaFormat: "png", mimeType: "image/png" }],
]);

/** A module "Visits" whose audio label is `audio`, a form "Visit" with a consent select and an intro field. */
function visitDoc(media: {
	audio?: string;
	consentImage?: string;
	introVideo?: string;
	noteHelpAudio?: string;
	logo?: string;
	icon?: string;
}): BlueprintDoc {
	return buildDoc(
		{
			appSettings: {
				showSavedForms: false,
				showIncompleteForms: false,
			},
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "consent",
									options: [
										{
											value: "yes",
											label: "Yes",
											...(media.consentImage && {
												media: { image: media.consentImage },
											}),
										},
									],
								}),
								f({
									kind: "text",
									id: "intro",
									...(media.introVideo && {
										label_media: { video: media.introVideo },
									}),
								}),
								f({
									kind: "text",
									id: "note",
									help: "More",
									...(media.noteHelpAudio && {
										help_media: { audio: media.noteHelpAudio },
									}),
								}),
							],
						},
					],
				},
			],
		},
		(doc) => {
			const moduleUuid = doc.moduleOrder[0];
			const mod = moduleUuid && doc.modules[moduleUuid];
			if (!mod) throw new Error("The fixture holds one module.");
			if (media.audio) mod.audioLabel = media.audio as never;
			if (media.icon) mod.icon = media.icon as never;
			if (media.logo) doc.logo = media.logo as never;
		},
	);
}

function withDeclaration(
	doc: BlueprintDoc,
	runsOnlyOn?: Platform,
): BlueprintDoc {
	return {
		...doc,
		appSettings: {
			...doc.appSettings,
			...(runsOnlyOn ? { runsOnlyOn } : {}),
		},
	};
}

describe("unplayableReferences and describeUnplayableReferences", () => {
	it("names a both-declared app's ICO option and AMR menu label, one sentence per platform", () => {
		const doc = visitDoc({ audio: AMR, consentImage: ICO });
		const found = unplayableReferences(doc, FORMATS, BOTH);
		expect(found.map((r) => [r.ref.location.kind, r.label, r.missing])).toEqual(
			[
				["module_audio_label", "AMR", ["web-apps"]],
				["option_media", "ICO", ["android"]],
			],
		);
		expect(describeUnplayableReferences(found)).toBe(
			'Web Apps can\'t play a file this app uses: the audio label on module "Visits" in AMR. Android can\'t play a file this app uses: the image on option "yes" of field "consent" (form "Visit") in ICO. You can replace or remove them, then try again.',
		);
	});

	it("names several files one platform can't play, and one no platform plays", () => {
		const doc = visitDoc({ audio: AMR, introVideo: HEVC, noteHelpAudio: WAV });
		const webApps = unplayableReferences(doc, FORMATS, ["web-apps"]);
		expect(
			describeUnplayableReferences(
				webApps.filter((r) => r.mediaFormat !== "unplayable"),
			),
		).toBe(
			'Web Apps can\'t play 2 files this app uses: the audio label on module "Visits" in AMR and the video on field "intro"\'s label (form "Visit") in MP4 (HEVC). You can replace or remove them, then try again.',
		);
		const nowhere = unplayableReferences(doc, FORMATS, ["android"]);
		expect(describeUnplayableReferences(nowhere)).toBe(
			'No CommCare app can play a file this app uses: the audio on field "note"\'s help (form "Visit") in WAV. You can replace it or remove it, then try again.',
		);
	});

	it("skips a built-in icon, a reference with no row, and a row with no format", () => {
		const doc = visitDoc({
			icon: builtinIconRef("household"),
			logo: testMediaAssetId("absent"),
			audio: testMediaAssetId("no-format"),
		});
		const formats = new Map(FORMATS);
		formats.set(testMediaAssetId("no-format"), { mimeType: "audio/wav" });
		expect(unplayableReferences(doc, formats, BOTH)).toEqual([]);
	});

	it("admits every file on the declaration that plays it", () => {
		const doc = withDeclaration(
			visitDoc({ audio: AMR, introVideo: HEVC }),
			"android",
		);
		expect(unplayableReferences(doc, FORMATS, ["android"])).toEqual([]);
		expect(
			unplayableReferences(visitDoc({ consentImage: ICO }), FORMATS, [
				"web-apps",
			]),
		).toEqual([]);
	});
});

describe("the judgments of one row", () => {
	it("reads a ready row with no format as unplayable", () => {
		const row = { kind: "image" as const, mimeType: "image/png" };
		expect(playsOnEvery("png", BOTH)).toBe(true);
		expect(attachPlatformSentence(row, BOTH)).toBe(
			"No CommCare app can play this image (PNG). Exporting it again as a PNG or JPEG fixes that.",
		);
		expect(assetUnavailableReason(row, BOTH)).toBe(
			"No CommCare app can play this file",
		);
	});

	it("writes the builder's sentence and the picker's line for a file one platform can't play", () => {
		const hevc = {
			kind: "video" as const,
			mimeType: "video/mp4",
			mediaFormat: "mp4-hevc" as const,
		};
		expect(attachPlatformSentence(hevc, BOTH)).toBe(
			"This video is MP4 (HEVC), which Web Apps can't play, and this app runs in Web Apps. Exporting it again as MP4 with H.264 Main video fixes that.",
		);
		expect(assetUnavailableReason(hevc, BOTH)).toBe(
			"Web Apps can't play MP4 (HEVC)",
		);
		expect(attachPlatformSentence(hevc, ["android"])).toBeNull();
		expect(
			attachPlatformSentence(
				{ kind: "audio", mimeType: "audio/wav", mediaFormat: "unplayable" },
				BOTH,
			),
		).toBe(
			"No CommCare app can play this audio (WAV). Exporting it again as MP3, or M4A with AAC audio, fixes that.",
		);
	});

	it("refuses an upload format only where none of its variants plays everywhere the app runs", () => {
		expect(formatUnavailableReason("video/mp4", BOTH)).toBeUndefined();
		expect(
			formatUnavailableReason("image/vnd.microsoft.icon", ["web-apps"]),
		).toBeUndefined();
		expect(formatUnavailableReason("image/vnd.microsoft.icon", BOTH)).toBe(
			"Android can't play ICO images, and this app runs on Android. Exporting it again as a PNG or JPEG fixes that.",
		);
		expect(formatUnavailableReason("audio/amr", BOTH)).toBe(
			"Web Apps can't play AMR audio, and this app runs in Web Apps. Exporting it again as MP3, or M4A with AAC audio, fixes that.",
		);
	});

	it("says where a file plays", () => {
		expect(playsOnLine(["web-apps", "android"])).toBe(
			"Plays in Web Apps and on Android",
		);
		expect(playsOnLine(["web-apps"])).toBe("Plays only in Web Apps");
		expect(playsOnLine(["android"])).toBe("Plays only on Android");
		expect(playsOnLine([])).toBe("No CommCare app plays this file");
	});

	it("never says a platform runs on or plays on Web Apps", () => {
		const copy = [
			attachPlatformSentence(
				{ kind: "audio", mimeType: "audio/amr", mediaFormat: "amr" },
				BOTH,
			),
			formatUnavailableReason("audio/midi", BOTH),
			playsOnLine(["web-apps"]),
			describeUnplayableReferences(
				unplayableReferences(visitDoc({ audio: AMR }), FORMATS, BOTH),
			),
		].join(" ");
		expect(copy).not.toMatch(/runs on Web Apps|Plays on Web Apps/);
	});
});

describe("browserStandIn", () => {
	it("gives the line for audio or video only Android plays", () => {
		expect(browserStandIn({ kind: "audio", playsOn: ["android"] })).toBe(
			"This audio plays on Android devices. Your browser can't play it here.",
		);
		expect(browserStandIn({ kind: "video", playsOn: ["android"] })).toBe(
			"This video plays on Android devices. Your browser can't play it here.",
		);
	});

	it("keeps the player for an unplayable row, a row with no format, a variant Web Apps plays, and an image", () => {
		expect(browserStandIn({ kind: "audio", playsOn: [] })).toBeNull();
		expect(browserStandIn({ kind: "audio" })).toBeNull();
		expect(
			browserStandIn({ kind: "video", playsOn: ["web-apps", "android"] }),
		).toBeNull();
		expect(browserStandIn({ kind: "image", playsOn: ["android"] })).toBeNull();
	});
});
