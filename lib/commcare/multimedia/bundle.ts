// lib/commcare/multimedia/bundle.ts
//
// Two outputs, split by consumer:
//
//   - `MediaBundle`    — `mediaSuiteXml` + `cczEntries`. The COMPILER
//                        reads these to write the media-bearing parts
//                        of the local CCZ archive (the descriptor +
//                        the bundled file bytes).
//   - `buildMultimediaMap(assets)` → `Record<string, MultimediaMapItem>`.
//                        The EXPANDER stamps this onto the
//                        HqApplication for the HQ-JSON / upload path.
//                        Produced separately so the compiler doesn't
//                        carry an HQ-JSON-shaped output it never
//                        consumes.
//
// The bundle is the totality boundary for media emission: given a
// manifest the caller built by walking every media reference in the
// doc, it MUST produce a complete bundle. A manifest entry missing the
// bytes it needs to bundle is a compiler-bug (the byte load is the
// caller's contract), not a recoverable emit-time state.
//
// `multimedia_map` shape verified against
// `commcare-hq/.../hqmedia/models.py::HQMediaMapItem` (`multimedia_id`,
// `media_type`, `version`) and
// `commcare-hq/.../app_manager/suite_xml/generator.py::media_resources`,
// which iterates `multimedia_map.items()` and raises `MediaResourceError`
// when a key doesn't start with `jr://file/`. The map key IS the
// fully-qualified jr:// reference (`jr://file/commcare/<hash><ext>`);
// CCHQ strips the `jr://file/` prefix to derive the install path.
// `media_type` is the CommCare media class name (`CommCareImage` /
// `CommCareAudio` / `CommCareVideo`).

import type { MediaKind } from "@/lib/domain/multimedia";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";
import {
	type AssetManifest,
	jrFileRef,
	type ResolvedMediaAsset,
} from "./assetWirePath";
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

/** The compiler-facing media bundle. The HQ-JSON `multimedia_map` is
 *  produced separately by `buildMultimediaMap` and stamped onto the
 *  application by the expander, so it doesn't appear here — the
 *  compiler reads `mediaSuiteXml` for the descriptor and `cczEntries`
 *  for the bundled file bytes. */
export interface MediaBundle {
	readonly mediaSuiteXml: string;
	readonly cczEntries: readonly MediaCczEntry[];
}

/**
 * Build the `multimedia_map` for a set of resolved assets. Key is the
 * fully-qualified `jr://file/commcare/<hash><ext>` reference (CCHQ
 * raises on a key that doesn't start with `jr://file/` — see the file
 * header). Value carries the media class + a placeholder
 * `multimedia_id` (the content hash — deterministic, and CCHQ
 * overwrites it via `create_mapping` once the bulk multimedia upload
 * reconciles the file by path). Used by the expander to stamp the
 * HqApplication for the upload path.
 */
export function buildMultimediaMap(
	assets: Iterable<ResolvedMediaAsset>,
): Record<string, MultimediaMapItem> {
	const map: Record<string, MultimediaMapItem> = {};
	for (const asset of assets) {
		map[jrFileRef(asset.wirePath)] = {
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
	// Dedupe by `wirePath` before producing the bundle's outputs. Two
	// distinct `AssetId`s can share the same `(contentHash, extension)`
	// — and therefore the same wire path — when the storage-layer dedup
	// probe races (a concurrent upload of the same bytes lands two
	// `ready` rows because the probe ignores `pending` rows;
	// `lib/db/mediaAssets.ts::findReadyAssetByOwnerAndHash`). Without
	// dedup the bundle would emit two `<media>` blocks with identical
	// `<resource id>` siblings + collide on the zip entry path (silent
	// `AdmZip.addFile` overwrite). Same wire path = same content hash =
	// same bytes, so picking either entry is byte-equivalent.
	const deduped = new Map<string, ResolvedMediaAsset>();
	for (const asset of manifest.values()) {
		deduped.set(asset.wirePath, asset);
	}
	// Sort by wire path so both outputs carry the same deterministic
	// order — same inputs always yield same bytes. `buildMediaSuiteXml`
	// sorts internally as a defensive double-bind.
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
		cczEntries,
	};
}
