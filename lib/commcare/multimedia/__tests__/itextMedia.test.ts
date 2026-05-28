import render from "dom-serializer";
import { describe, expect, it } from "vitest";
import { RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import { asAssetId, type Media } from "@/lib/domain/multimedia";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import { itextMediaValues } from "../itextMedia";

/** Build a manifest from terse asset specs, deriving the wire path. */
function manifestOf(
	specs: ReadonlyArray<Omit<ResolvedMediaAsset, "wirePath" | "mimeType">>,
): AssetManifest {
	const m = new Map<ReturnType<typeof asAssetId>, ResolvedMediaAsset>();
	for (const s of specs) {
		m.set(asAssetId(s.assetId), {
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

const MANIFEST = manifestOf([
	{
		assetId: asAssetId("img-1"),
		contentHash: HASH_IMG,
		extension: ".png",
		kind: "image",
	},
	{
		assetId: asAssetId("aud-1"),
		contentHash: HASH_AUD,
		extension: ".mp3",
		kind: "audio",
	},
	{
		assetId: asAssetId("vid-1"),
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
		expect(itextMediaValues({ image: "img-1" }, undefined, "test")).toEqual([]);
	});

	it("emits one <value form=image> with the jr://file/commcare path", () => {
		expect(renderValues({ image: "img-1" }, MANIFEST)).toBe(
			`<value form="image">jr://file/commcare/${HASH_IMG}.png</value>`,
		);
	});

	it("emits image, then audio, then video — one per present slot", () => {
		expect(
			renderValues(
				{ image: "img-1", audio: "aud-1", video: "vid-1" },
				MANIFEST,
			),
		).toBe(
			`<value form="image">jr://file/commcare/${HASH_IMG}.png</value>` +
				`<value form="audio">jr://file/commcare/${HASH_AUD}.mp3</value>` +
				`<value form="video">jr://file/commcare/${HASH_VID}.mp4</value>`,
		);
	});

	it("emits only the present slots (audio-only)", () => {
		expect(renderValues({ audio: "aud-1" }, MANIFEST)).toBe(
			`<value form="audio">jr://file/commcare/${HASH_AUD}.mp3</value>`,
		);
	});

	it("throws a compiler-bug when a referenced asset is missing from the manifest", () => {
		expect(() => renderValues({ image: "ghost" }, MANIFEST)).toThrow(
			/references a media asset I couldn't load.*ghost/s,
		);
	});
});
