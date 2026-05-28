/**
 * Rule: every referenced asset's `owner` matches the app's owner.
 *
 * Fires when a manifest row's `owner` doesn't match the expected
 * owner. The user sees: "this media belongs to someone else, the
 * app can't ship with it." The fix: upload an owned copy and attach
 * it, or clear the slot.
 *
 * An id missing from the manifest is `mediaAssetExists`'s concern;
 * this rule only judges rows the manifest does carry.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { type ValidationError, validationError } from "../../errors";
import {
	describeLocation,
	navigabilityDetailsFor,
	scopeFor,
	validationLocationFor,
} from "./shared";

/**
 * Walk every media reference; for any whose resolved row's `owner`
 * doesn't match the expected app owner, emit
 * MEDIA_ASSET_FOREIGN_OWNER. References whose ids don't resolve at
 * all are silently skipped (left to `mediaAssetExists`).
 */
export function mediaAssetOwnership(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	expectedOwner: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		const record = manifest.get(ref.assetId);
		if (!record) continue;
		if (record.owner === expectedOwner) continue;
		errors.push(
			validationError(
				"MEDIA_ASSET_FOREIGN_OWNER",
				scopeFor(ref.location),
				`The media asset at ${describeLocation(ref.location)} belongs to a different user, so this app can't ship with it. Upload your own copy of the media and attach it to the slot, or clear the slot.`,
				validationLocationFor(ref.location),
				{ assetId: ref.assetId, ...navigabilityDetailsFor(ref.location) },
			),
		);
	}
	return errors;
}
