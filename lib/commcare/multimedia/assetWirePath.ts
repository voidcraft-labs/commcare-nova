// lib/commcare/multimedia/assetWirePath.ts
//
// The wire-path layer for media: the bridge between a Nova `AssetId`
// (an opaque UUID) and the strings CommCare's wire formats expect.
//
// Two derived strings per asset, both content-hash-keyed so they're
// stable and deterministic across compiles:
//
//   - the CCZ entry path / media-suite location: `commcare/<hash><ext>`
//   - the `jr://file/...` reference used inside itext `<value>`,
//     `<media_image>`/`<media_audio>` locales, enum-image templates,
//     and the app-logo profile property.
//
// CommCare resolves a `jr://file/commcare/<hash><ext>` reference to the
// installed file at `commcare/<hash><ext>` (relative to the suite).
// commcare-core's `BasicInstaller::install` returns false for a
// remote-authority resource (there's a `// TODO: Implement local cache
// code` on that branch), so every byte MUST be bundled locally in the
// CCZ — this is why the media-suite resource emits an `authority="local"`
// location and the compiler writes the bytes into the archive.
//
// This module owns NO bytes and NO CommCare element construction — it's
// the path vocabulary the other helpers (`itextMedia`, `mediaSuiteXml`,
// `navMenuMedia`, `logoEntry`, `imageMapColumn`) build on.

import {
	type AssetId,
	asAssetId,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";

/**
 * The `jr://file/` prefix every CommCare media reference carries. A
 * reference is this prefix + the wire path (`commcare/<hash><ext>`).
 * Verified against `commcare-hq/.../suite_xml/generator.py::media_resources`
 * (the `PREFIX = 'jr://file/'` it strips to compute the install path) and
 * the fixture `tests/data/suite/form_with_media_refs.xml`.
 */
const JR_FILE_PREFIX = "jr://file/";

/**
 * The single install directory all Nova media lives under. CommCare
 * treats `jr://file/commcare/...` as the on-device install root for
 * app media; the media-suite `<media path="../../commcare">` and the
 * CCZ entry path both derive from this segment.
 */
const MEDIA_DIR = "commcare";

/**
 * One referenced asset, resolved to everything the wire emitters need.
 * The caller (the compile / upload route, or the bundle builder) loads
 * the asset row from Firestore and — when producing an actual archive —
 * the bytes from GCS, then projects to this shape.
 *
 * `bytes` is optional because not every consumer needs them: the
 * expander emits only references (`jr://file/...` strings) and the
 * HQ-JSON preview needs only paths, while `compileCcz` and the HQ
 * multimedia upload need the bytes to bundle. A consumer that requires
 * bytes and finds them absent throws a compiler-bug (the byte load is
 * the caller's contract, not an emit-time recoverable state).
 */
export interface ResolvedMediaAsset {
	readonly assetId: AssetId;
	/** `commcare/<contentHash><extension>` — CCZ entry path + media-suite location stem. */
	readonly wirePath: string;
	readonly kind: MediaKind;
	readonly mimeType: string;
	readonly contentHash: string;
	/** Canonical extension for the sniffed MIME, including the leading dot (`.png`). */
	readonly extension: string;
	/** Validated bytes, present only when the consumer will bundle the file. */
	readonly bytes?: Buffer;
}

/**
 * The set of assets an emission run may reference, keyed by `AssetId`.
 *
 * Two modes, distinguished by presence:
 *   - `undefined` — media emission is OFF. The validation loop and any
 *     preview that doesn't load assets pass `undefined`; every emitter
 *     skips media entirely (no references, no media-suite, no
 *     multimedia_map). The app is still structurally valid; it just
 *     carries no media.
 *   - a `Map` — media emission is ON. The caller has resolved EVERY
 *     asset the doc references (it walked the doc to build this map), so
 *     a referenced `AssetId` that's missing from the map is a
 *     compiler-bug, not a recoverable state — see `requireAssetRef`.
 */
export type AssetManifest = ReadonlyMap<AssetId, ResolvedMediaAsset>;

/**
 * Derive the CCZ entry path / media-suite location stem for an asset:
 * `commcare/<contentHash><extension>`. `extension` already carries its
 * leading dot (`.png`), so it concatenates directly.
 */
export function wirePathFor(contentHash: string, extension: string): string {
	return `${MEDIA_DIR}/${contentHash}${extension}`;
}

/**
 * Wrap a wire path as the `jr://file/...` reference CommCare resolves at
 * runtime. `wirePath` is the `commcare/<hash><ext>` stem from
 * `wirePathFor`.
 */
export function jrFileRef(wirePath: string): string {
	return `${JR_FILE_PREFIX}${wirePath}`;
}

/**
 * Resolve an `AssetId` to its `jr://file/...` reference against a
 * manifest known to contain it. Throws a compiler-bug on a miss: the
 * caller built the manifest by walking the doc, so every referenced
 * asset is present by construction; a miss means the walk and the
 * emitter disagree about what the doc references.
 *
 * Callers that legitimately have no manifest (media OFF) must guard on
 * `manifest === undefined` BEFORE reaching here — this helper is only
 * for the media-ON path.
 *
 * `assetId` is taken as a plain `string` because that's what the doc
 * carries — the `AssetId` brand is a compile-time-only decoration (the
 * Zod schema is a plain `z.string()`, no transform, so tool-schema JSON
 * generation stays clean), so the manifest key is re-branded here for
 * the lookup.
 */
export function requireAssetRef(
	assetId: string,
	manifest: AssetManifest,
	where: string,
): string {
	const resolved = manifest.get(asAssetId(assetId));
	if (!resolved) {
		throw new Error(
			compilerBugMessage({
				where,
				invariant: `media asset "${assetId}" is referenced by the blueprint but absent from the resolved asset manifest`,
				detail:
					"The manifest is built by walking every media reference in the doc, so every referenced asset must be present. A miss means the reference walk that built the manifest and the emitter that consumes it disagree about which assets the doc uses — reconcile the two walks.",
			}),
		);
	}
	return jrFileRef(resolved.wirePath);
}
