// lib/media/mediaValidation.ts
//
// The media-validation gate for the media-ON wire-emission entry points
// (the HQ upload routes/tools + the `.ccz` compile route/tool). Those
// entry points expand media-ON, where a stale media reference (deleted,
// still-pending, foreign-owned, or kind-mismatched asset) makes
// `expandDoc` throw `requireAssetRef` — surfacing to the user as an
// opaque 500 / generic tool error. This gate runs the same media rules
// the SA validation loop runs, BEFORE expand, so the user instead gets
// the rule's actionable Elm-shape message with the carrier location.
//
// Server-only: it reads Firestore (the owner's asset rows). It is the
// only media-side consumer of `lib/commcare/validator`; the manifest
// builder (`lib/media/manifest.ts`) crosses the same one-way
// `@/lib/commcare` boundary too, but via `multimedia/assetWirePath`, not
// the validator. Both therefore carry their own file-specific entry in
// biome.json's allowlist (mirroring `!lib/media/manifest.ts`).

import "server-only";

import {
	isMediaValidationError,
	type ValidationError,
} from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";

/**
 * Run media validation against a doc and return ONLY the media-category
 * errors — the actionable issues a media-ON expand would otherwise turn
 * into a `requireAssetRef` throw.
 *
 * The asset load here is INTENTIONALLY distinct from the manifest that
 * feeds `expandDoc`. `resolveMediaManifest` filters to `ready` rows (the
 * emitter can't bundle unvalidated bytes), but `loadAssetsByIds` returns
 * ready AND pending rows (owner-filtered). Pending rows must reach the
 * validator so `mediaAssetReady` can fire its "still uploading" message
 * rather than the manifest's `ready`-only view collapsing it into a
 * "not found" miss. This mirrors `validationLoop.ts::loadManifestForLoop`
 * exactly — two loads with different filters, one extra Firestore read
 * per upload/compile (the cost the SA path already pays).
 *
 * The full `runValidation` runs (with the manifest as
 * `RunValidationOptions.mediaAssets`), then the result is filtered to
 * the media category. Running full-then-filter — rather than a
 * media-rules-only subset run — is deliberate: `imageMapValueUnique`
 * lives in `MODULE_RULES`, not `MEDIA_ASSET_RULES`, so a subset run
 * would re-implement runner internals and drift. The filter keeps the
 * gate from newly blocking previously-working non-media uploads on
 * these entry points (they historically ran only schema parse, never
 * `runValidation`).
 *
 * Returns an empty array when the doc references no media — `runValidation`
 * still runs (cheap), but no media rule has anything to fire on.
 */
export async function collectMediaValidationErrors(
	doc: BlueprintDoc,
	owner: string,
): Promise<ValidationError[]> {
	const ids = [...collectAssetRefs(doc)];

	// Build the asset manifest the asset-context rules consume. An empty
	// map (no refs) still runs the media group — the rules produce zero
	// errors against zero refs, and `imageMapValueUnique` (manifest-
	// independent) runs regardless via `MODULE_RULES`.
	const rows = ids.length === 0 ? [] : await loadAssetsByIds(owner, ids);
	const mediaAssets = new Map(rows.map((row) => [row.id as string, row]));

	const errors = runValidation(doc, { mediaAssets });
	return errors.filter(isMediaValidationError);
}
