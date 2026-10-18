// lib/commcare/multimedia/bundle.ts
//
// `MediaBundle` — `mediaSuiteXml` + `cczEntries`. The COMPILER reads these
// to write the media-bearing parts of the local CCZ archive (the descriptor
// + the bundled file bytes).
//
// The bundle is the totality boundary for media emission: given a
// manifest the caller built by walking every media reference in the
// doc, it MUST produce a complete bundle. A manifest entry missing the
// bytes it needs to bundle is a compiler-bug (the byte load is the
// caller's contract), not a recoverable emit-time state.
//
// The HQ app Nova sends carries no `multimedia_map`. CommCare HQ's media
// upload matches each file to a path the app's content references and
// writes the map itself (`corehq/apps/hqmedia/tasks.py::
// process_bulk_upload_zip`), and an update never writes the key Nova sends
// (`models/applications.py::ApplicationBase._update_excluded_fields`).

import { compilerBugMessage } from "@/lib/domain/expression/errors";
import type { AssetManifest, ResolvedMediaAsset } from "./assetWirePath";
import { buildMediaSuiteXml } from "./mediaSuiteXml";

/** One file to write into the CCZ archive: the wire path (zip entry)
 *  and its validated bytes. */
export interface MediaCczEntry {
	readonly path: string;
	readonly bytes: Buffer;
}

/** The compiler-facing media bundle: the compiler reads `mediaSuiteXml`
 *  for the descriptor and `cczEntries` for the bundled file bytes. */
export interface MediaBundle {
	readonly mediaSuiteXml: string;
	readonly cczEntries: readonly MediaCczEntry[];
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
	// distinct `MediaAssetId`s can share the same `(contentHash, extension)`
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
