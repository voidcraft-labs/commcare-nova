import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	AssetManifest,
	ResolvedMediaAsset,
} from "@/lib/commcare/multimedia/assetWirePath";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";

// Real, small media. Multiple asset IDs sharing content exercise bundle dedup.
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWOYJhLwHwAEOAH6SipT6gAAAABJRU5ErkJggg==",
	"base64",
);
const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
const media = {
	image: { bytes: png, extension: ".png", mimeType: "image/png" },
	audio: { bytes: wav, extension: ".wav", mimeType: "audio/wav" },
	video: {
		bytes: readFileSync(
			new URL("../../media/__tests__/fixtures/tiny-video.mp4", import.meta.url),
		),
		extension: ".mp4",
		mimeType: "video/mp4",
	},
};

/**
 * The media manifest the compiler fuzz publishes a document with: every
 * asset slot resolved to real bytes of its kind. The proof corpus's fuzz
 * sample uploads the same bytes (`proof/corpus/fuzzSample.ts`).
 */
export function manifestFor(doc: BlueprintDoc): AssetManifest {
	const manifest = new Map<ResolvedMediaAsset["assetId"], ResolvedMediaAsset>();
	for (const ref of walkAssetRefs(doc)) {
		const fixture = media[ref.slotKind];
		const contentHash = createHash("sha256")
			.update(fixture.bytes)
			.digest("hex");
		manifest.set(ref.assetId, {
			assetId: ref.assetId,
			kind: ref.slotKind,
			...fixture,
			contentHash,
			wirePath: `commcare/${contentHash}${fixture.extension}`,
		});
	}
	return manifest;
}
