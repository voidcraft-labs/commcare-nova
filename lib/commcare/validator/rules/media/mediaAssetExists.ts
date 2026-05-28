/**
 * Rule: every `AssetId` referenced by the blueprint resolves to a
 * row in the resolved manifest.
 *
 * Fires when a carrier holds an asset id the manifest doesn't carry.
 * The user sees: "the carrier points at nothing." The fix: open the
 * carrier, pick a different asset, or clear the slot.
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
