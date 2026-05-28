import render from "dom-serializer";
import { describe, expect, it } from "vitest";
import { RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import { asAssetId } from "@/lib/domain/multimedia";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import { buildNavMediaDicts, buildNavMenuNode } from "../navMenuMedia";

const HASH_ICON = "1".repeat(64);
const HASH_AUDIO = "2".repeat(64);

const MANIFEST: AssetManifest = new Map<
	ReturnType<typeof asAssetId>,
	ResolvedMediaAsset
>([
	[
		asAssetId("icon-1"),
		{
			assetId: asAssetId("icon-1"),
			wirePath: `commcare/${HASH_ICON}.png`,
			kind: "image",
			mimeType: "image/png",
			contentHash: HASH_ICON,
			extension: ".png",
		},
	],
	[
		asAssetId("audio-1"),
		{
			assetId: asAssetId("audio-1"),
			wirePath: `commcare/${HASH_AUDIO}.mp3`,
			kind: "audio",
			mimeType: "audio/mpeg",
			contentHash: HASH_AUDIO,
			extension: ".mp3",
		},
	],
]);

describe("buildNavMediaDicts", () => {
	it("returns empty dicts when the carrier has no media", () => {
		expect(buildNavMediaDicts(undefined, undefined, MANIFEST, "t")).toEqual({
			media_image: {},
			media_audio: {},
		});
	});

	it("returns empty dicts when media emission is off (no manifest)", () => {
		expect(buildNavMediaDicts("icon-1", "audio-1", undefined, "t")).toEqual({
			media_image: {},
			media_audio: {},
		});
	});

	it("stamps an en-keyed jr:// path per present slot", () => {
		expect(buildNavMediaDicts("icon-1", "audio-1", MANIFEST, "t")).toEqual({
			media_image: { en: `jr://file/commcare/${HASH_ICON}.png` },
			media_audio: { en: `jr://file/commcare/${HASH_AUDIO}.mp3` },
		});
	});
});

describe("buildNavMenuNode", () => {
	it("emits a bare <text><locale/> and no app_strings when the carrier has no media", () => {
		const { node, strings } = buildNavMenuNode(
			"modules.m0",
			undefined,
			undefined,
			MANIFEST,
			"t",
		);
		expect(render(node, RENDER_OPTS)).toBe(
			'<text><locale id="modules.m0"/></text>',
		);
		expect(strings).toEqual({});
	});

	it("wraps the text in a <display> with media locales + app_strings when media is set", () => {
		const { node, strings } = buildNavMenuNode(
			"modules.m0",
			"icon-1",
			"audio-1",
			MANIFEST,
			"t",
		);
		expect(render(node, RENDER_OPTS)).toBe(
			"<display>" +
				'<text><locale id="modules.m0"/></text>' +
				'<text form="image"><locale id="modules.m0.icon"/></text>' +
				'<text form="audio"><locale id="modules.m0.audio"/></text>' +
				"</display>",
		);
		expect(strings).toEqual({
			"modules.m0.icon": `jr://file/commcare/${HASH_ICON}.png`,
			"modules.m0.audio": `jr://file/commcare/${HASH_AUDIO}.mp3`,
		});
	});

	it("emits a <display> with only the icon when audio is absent", () => {
		const { node, strings } = buildNavMenuNode(
			"forms.m0f0",
			"icon-1",
			undefined,
			MANIFEST,
			"t",
		);
		expect(render(node, RENDER_OPTS)).toBe(
			"<display>" +
				'<text><locale id="forms.m0f0"/></text>' +
				'<text form="image"><locale id="forms.m0f0.icon"/></text>' +
				"</display>",
		);
		expect(strings).toEqual({
			"forms.m0f0.icon": `jr://file/commcare/${HASH_ICON}.png`,
		});
	});
});
