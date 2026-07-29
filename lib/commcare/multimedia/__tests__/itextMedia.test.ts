import render from "dom-serializer";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import type { Media, MediaAssetId } from "@/lib/domain/multimedia";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import { itextMediaValues } from "../itextMedia";

/** Build a manifest from terse asset specs, deriving the wire path. */
function manifestOf(
	specs: ReadonlyArray<
		Omit<ResolvedMediaAsset, "assetId" | "wirePath" | "mimeType"> & {
			assetId: MediaAssetId;
		}
	>,
): AssetManifest {
	const m = new Map<MediaAssetId, ResolvedMediaAsset>();
	for (const s of specs) {
		m.set(s.assetId, {
			...s,
			wirePath: `commcare/${s.contentHash}${s.extension}`,
			mimeType: "image/png",
		});
	}
	return m;
}

const HASH_IMG = "a".repeat(64);
const HASH_AUD = "b".repeat(64);
const HASH_VID = "c".repeat(64);
const IMG = testMediaAssetId("img-1");
const AUD = testMediaAssetId("aud-1");
const VID = testMediaAssetId("vid-1");

const MANIFEST = manifestOf([
	{
		assetId: IMG,
		contentHash: HASH_IMG,
		extension: ".png",
		kind: "image",
	},
	{
		assetId: AUD,
		contentHash: HASH_AUD,
		extension: ".mp3",
		kind: "audio",
	},
	{
		assetId: VID,
		contentHash: HASH_VID,
		extension: ".mp4",
		kind: "video",
	},
]);

function renderValues(
	media: Media | undefined,
	manifest: AssetManifest | undefined,
) {
	return itextMediaValues(media, manifest, "test")
		.map((el) => render(el, RENDER_OPTS))
		.join("");
}

describe("itextMediaValues", () => {
	it("emits no values when media is absent", () => {
		expect(itextMediaValues(undefined, MANIFEST, "test")).toEqual([]);
	});

	it("emits no values when the manifest is absent (media emission off)", () => {
		expect(itextMediaValues({ image: IMG }, undefined, "test")).toEqual([]);
	});

	it("emits one <value form=image> with the jr://file/commcare path", () => {
		expect(renderValues({ image: IMG }, MANIFEST)).toBe(
			`<value form="image">jr://file/commcare/${HASH_IMG}.png</value>`,
		);
	});

	it("emits image, then audio, then video — one per present slot", () => {
		expect(renderValues({ image: IMG, audio: AUD, video: VID }, MANIFEST)).toBe(
			`<value form="image">jr://file/commcare/${HASH_IMG}.png</value>` +
				`<value form="audio">jr://file/commcare/${HASH_AUD}.mp3</value>` +
				`<value form="video">jr://file/commcare/${HASH_VID}.mp4</value>`,
		);
	});

	it("emits only the present slots (audio-only)", () => {
		expect(renderValues({ audio: AUD }, MANIFEST)).toBe(
			`<value form="audio">jr://file/commcare/${HASH_AUD}.mp3</value>`,
		);
	});

	it("throws a compiler-bug when a referenced asset is missing from the manifest", () => {
		const ghost = testMediaAssetId("ghost");
		expect(() => renderValues({ image: ghost }, MANIFEST)).toThrow(
			new RegExp(
				`references a media asset that couldn't be loaded.*${ghost}`,
				"s",
			),
		);
	});
});
