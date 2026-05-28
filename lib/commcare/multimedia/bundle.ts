// lib/commcare/multimedia/bundle.ts
//
// The media bundle: everything the COMPILER needs to turn a resolved
// asset manifest into the media-bearing parts of a CCZ —
//
//   - `mediaSuiteXml`  — the media_suite.xml descriptor string.
//   - `multimediaMap`  — the HQ-JSON `multimedia_map` (also stamped onto
//                        the HqApplication for the upload path).
//   - `cczEntries`     — the (path, bytes) pairs to write into the ZIP.
//
// The bundle is the totality boundary for media emission: given a
// manifest the caller built by walking every media reference in the
// doc, it MUST produce a complete bundle. A manifest entry missing the
// bytes it needs to bundle is a compiler-bug (the byte load is the
// caller's contract), not a recoverable emit-time state.
//
// `multimedia_map` shape verified against
// `commcare-hq/.../hqmedia/models.py::HQMediaMapItem` (`multimedia_id`,
// `media_type`, `version`) and `ApplicationMediaMixin.multimedia_map`
// (the map key is the path WITHOUT the `jr://file/` prefix —
// `commcare/<file>`, NOT `jr://file/commcare/<file>`). `media_type` is
// the CommCare media class name (`CommCareImage` / `CommCareAudio` /
// `CommCareVideo`).

import type { MediaKind } from "@/lib/domain/multimedia";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import type { AssetManifest, ResolvedMediaAsset } from "./assetWirePath";
import { buildMediaSuiteXml } from "./mediaSuiteXml";

/**
 * CommCare's media document class per Nova media kind. This is the
 * `media_type` string in each `multimedia_map` value and the type
 * CommCare routes the file to on upload.
 */
const MEDIA_TYPE_FOR_KIND: Record<MediaKind, string> = {
	image: "CommCareImage",
	audio: "CommCareAudio",
	video: "CommCareVideo",
};

/** One `multimedia_map` value. CCHQ reassigns `multimedia_id` after the
 *  step-2 multimedia upload reconciles files by path; Nova seeds a
 *  deterministic placeholder so the inbound shape is valid. */
export interface MultimediaMapItem {
	readonly multimedia_id: string;
	readonly media_type: string;
	readonly version: number;
}

/** One file to write into the CCZ archive: the wire path (zip entry)
 *  and its validated bytes. */
export interface MediaCczEntry {
	readonly path: string;
	readonly bytes: Buffer;
}

/** The compiler-facing media bundle. */
export interface MediaBundle {
	readonly mediaSuiteXml: string;
	readonly multimediaMap: Record<string, MultimediaMapItem>;
	readonly cczEntries: readonly MediaCczEntry[];
}

/**
 * Build the `multimedia_map` for a set of resolved assets. Key is the
 * wire path (`commcare/<file>`, no `jr://file/` prefix); value carries
 * the media class + a placeholder `multimedia_id` (the content hash —
 * deterministic, and CCHQ overwrites it after the multimedia upload).
 * Used by the expander to stamp the HqApplication for the upload path.
 */
export function buildMultimediaMap(
	assets: Iterable<ResolvedMediaAsset>,
): Record<string, MultimediaMapItem> {
	const map: Record<string, MultimediaMapItem> = {};
	for (const asset of assets) {
		map[asset.wirePath] = {
			multimedia_id: asset.contentHash,
			media_type: MEDIA_TYPE_FOR_KIND[asset.kind],
			version: 1,
		};
	}
	return map;
}

/**
 * Build the complete compiler-facing media bundle from a resolved
 * manifest. Every manifest entry MUST carry its `bytes` (the compiler
 * is producing an archive); a missing buffer is a compiler-bug because
 * the byte load is the caller's contract for the compile path.
 *
 * `where` names the calling site for the compiler-bug message.
 */
export function buildMediaBundle(
	manifest: AssetManifest,
	where: string,
): MediaBundle {
	// Dedupe by `wirePath` BEFORE producing the bundle's three outputs.
	// Two distinct `AssetId`s can share the same `(contentHash, extension)`
	// — and therefore the same wire path — when the storage-layer dedup
	// probe races (a concurrent upload of the same bytes lands two `ready`
	// rows because the probe ignores `pending` rows, documented in
	// `lib/db/mediaAssets.ts::findReadyAssetByOwnerAndHash`). Without
	// dedup, the bundle would emit two `<media>` blocks with identical
	// `<resource id>` siblings + two cczEntries collisions (silent
	// `AdmZip.addFile` overwrite) + a `multimediaMap` key overwrite. The
	// payload is byte-identical so picking either entry is correct; we
	// pick the last-iterated to keep `Map.set`'s natural semantics.
	const deduped = new Map<string, ResolvedMediaAsset>();
	for (const asset of manifest.values()) {
		deduped.set(asset.wirePath, asset);
	}
	// Sort by wire path so the bundle's three outputs (mediaSuiteXml,
	// multimediaMap, cczEntries) carry the same deterministic order —
	// same inputs always yield same bytes. `buildMediaSuiteXml` sorts
	// internally; the other two consume the pre-sorted list.
	const assets = [...deduped.values()].sort((a, b) =>
		a.wirePath < b.wirePath ? -1 : a.wirePath > b.wirePath ? 1 : 0,
	);
	const cczEntries: MediaCczEntry[] = assets.map((asset) => {
		if (!asset.bytes) {
			throw new Error(
				compilerBugMessage({
					where,
					invariant: `media asset "${asset.assetId}" (${asset.wirePath}) reached the CCZ bundler without loaded bytes`,
					detail:
						"The compile path requires the caller to load each referenced asset's bytes from storage before compiling. A manifest entry without bytes means the loader skipped it or the manifest was built for a path-only consumer (preview / expand) and wrongly handed to the compiler.",
				}),
			);
		}
		return { path: asset.wirePath, bytes: asset.bytes };
	});

	return {
		mediaSuiteXml: buildMediaSuiteXml(assets),
		multimediaMap: buildMultimediaMap(assets),
		cczEntries,
	};
}
