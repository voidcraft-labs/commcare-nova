/**
 * Rule: every `AssetId` referenced by the blueprint resolves to a
 * row in the resolved manifest.
 *
 * The manifest is built by walking the doc's references and loading
 * the owner's `ready` rows that match. An id the doc holds onto but
 * the manifest doesn't carry has one of three causes:
 *
 *   1. The asset was deleted from the library after the reference
 *      was attached (most common).
 *   2. The reference points at an asset that never existed (a typo
 *      from a hand-edited tool call, a copy-paste from another
 *      app).
 *   3. The reference points at an asset owned by a different user;
 *      the loader's owner filter dropped it. (The dedicated
 *      `mediaAssetOwnership` rule catches that case more
 *      specifically when the manifest happens to include the
 *      foreign row — never the production loader, which filters
 *      first, but a test fixture or a future loader widening
 *      might.)
 *
 * All three surface as "the carrier points at nothing" at compile.
 * The fix is the same regardless of cause: open the carrier, pick a
 * different asset, or clear the slot.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { type ValidationError, validationError } from "../../errors";
import { describeLocation, scopeFor, validationLocationFor } from "./shared";

/**
 * Walk every media reference; emit MEDIA_ASSET_NOT_FOUND for any
 * `assetId` the manifest doesn't carry. Rule is a no-op when the doc
 * holds zero media references — `walkAssetRefs` short-circuits and the
 * cost is one generator instantiation.
 */
export function mediaAssetExists(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	// Carried for the uniform `MediaAssetRule` shape; not consulted —
	// existence is owner-agnostic. The dedicated ownership rule
	// (`mediaAssetOwnership`) is the one that pivots on the expected
	// owner.
	_expectedOwner: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		if (manifest.has(ref.assetId)) continue;
		errors.push(
			validationError(
				"MEDIA_ASSET_NOT_FOUND",
				scopeFor(ref.location),
				`The media asset at ${describeLocation(ref.location)} couldn't be found. It may have been deleted from the media library, or the reference may be stale. Open that slot and pick a different asset, or clear the slot if no media should sit there.`,
				validationLocationFor(ref.location),
				{ assetId: ref.assetId },
			),
		);
	}
	return errors;
}
